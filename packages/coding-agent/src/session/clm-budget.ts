import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { isTranscriptUsageAnchor } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";

/** Text prefix of every CLM capacity refusal; turn recovery never replays a message carrying it. */
export const CLM_CAPACITY_ERROR_PREFIX = "CLM request does not fit the context window";

/** Deterministic local refusal: replaying the same request can never fit, so it is not a retriable provider error. */
export class ClmCapacityError extends Error {
	constructor(detail: string) {
		super(`${CLM_CAPACITY_ERROR_PREFIX}: ${detail}`);
		this.name = "ClmCapacityError";
	}
}

export interface ClmBudgetInputs {
	identity: string;
	provider: string;
	model: string;
	/** Scope of the measured local/provider ratio: endpoint and conversation. A ratio never crosses scopes. */
	ratioScope?: string;
	messages: readonly AgentMessage[];
	systemPrompt: readonly string[];
	toolsKey: string;
	nonMessageTokens: number;
	providerContext?: Context;
	allowAnchor?: boolean;
	unsafePayload?: boolean;
}

export interface ClmBudgetEstimate {
	localRequestTokens: number;
	/** True when local counts come from the model's own tokenizer, not a proxy encoding or byte heuristic. */
	localExact: boolean;
	calibratedRequestTokens: number | null;
	/** Local count scaled by the last measured provider/local ratio, when no exact anchor applies. */
	ratioAdjustedRequestTokens: number | null;
	estimatedRequestTokens: number;
	/** Error allowance for the part of the estimate no provider measured, scaled by local count quality. */
	safetyMarginTokens: number;
	usageAnchor: {
		valid: boolean;
		reason:
			| "valid"
			| "occupancy"
			| "unmeasured"
			| "candidate"
			| "identity"
			| "prefix"
			| "framing"
			| "provider-prefix"
			| "payload-hook";
		source: "prompt" | "occupancy" | null;
		occupancyTokens: number | null;
		promptTokens: number | null;
		provider: string | null;
		model: string | null;
		timestamp: number | null;
	};
}

/** CLM capacity lines for one request estimate. */
export interface ClmCapacity {
	contextWindow: number;
	/** Reply reserve: the request's effective output cap, never a compaction reserve. */
	generationReserveTokens: number;
	/** Smallest reply still dispatched; below it the request is refused. */
	minimumReplyTokens: number;
	/** Hard capacity: window minus the full reply reserve. Past it the reply is capped. */
	capacityTokens: number;
	/** Configured compaction threshold; past it the host urgently asks for context edits but never blocks. */
	softLimitTokens: number;
	/** `capacityTokens` minus the estimate and its safety margin. */
	remainingTokens: number;
}

interface RequestSnapshot {
	identity: string;
	provider: string;
	model: string;
	ratioKey: string;
	prefix: string[];
	providerPrefix: string[];
	systemPrompt: readonly string[];
	toolsKey: string;
	nonMessageTokens: number;
	providerSystemPrompt: readonly string[];
	providerToolsKey: string;
	providerNonMessageTokens: number;
	/** Local count of the converted provider request; the measured/local drift ratio divides by it. */
	providerLocalTokens: number;
	/** Local count of the raw request; later rewrites are measured as a delta against it. */
	inputLocalTokens: number;
}

interface UsageAnchor extends RequestSnapshot {
	measuredTokens: number;
	source: "prompt" | "occupancy";
	provider: string;
	model: string;
	timestamp: number;
	/** Provider/local drift, clamped: larger gaps are fixed provider-side content the anchor already carries. */
	ratio: number;
}

/** Margin rates: exact tokenizers miss only framing/tool ids/images (~9% observed); proxies also miss content. */
const EXACT_MARGIN_RATE = 0.1;
const INEXACT_MARGIN_RATE = 0.25;
const MARGIN_FLOOR_TOKENS = 64;
/** Per-token drift beyond this (base64 under bytes/4 reaches ~2.7×) is additive provider content, not drift. */
const MAX_DRIFT_RATIO = 4;

function fingerprint(message: AgentMessage): string {
	if (message.role === "assistant") {
		const { contextSnapshot: _snapshot, completedAt: _completed, ...semantic } = message;
		return Bun.hash(JSON.stringify(semantic)).toString(16);
	}
	return Bun.hash(JSON.stringify(message)).toString(16);
}

function prefixMatches(prefix: readonly string[], messages: readonly AgentMessage[]): boolean {
	return messages.length >= prefix.length && prefix.every((value, index) => value === fingerprint(messages[index]));
}

function promptExtends(before: readonly string[], after: readonly string[]): boolean {
	return after.length >= before.length && before.every((value, index) => value === after[index]);
}

/**
 * Provider input certifies only the exact request prefix, never its generated answer or a rewritten history.
 * Once a rewrite invalidates that prefix, the measured provider/local ratio keeps bounding the local count
 * so an edit cannot erase a known undercount.
 */
export class ClmBudgetTracker {
	#anchor: UsageAnchor | undefined;
	#pending: RequestSnapshot | undefined;

	constructor(readonly tokenizer: () => Tokenizer) {}

	#providerNonMessageTokens(context: Context): number {
		const framing = [...(context.systemPrompt ?? [])];
		for (const tool of [...(context.tools ?? []), ...(context.inactiveTools ?? [])]) {
			framing.push(tool.name, tool.description, JSON.stringify(tool.parameters));
		}
		return this.tokenizer().countTokens(framing);
	}

	capture(inputs: ClmBudgetInputs & { providerContext: Context }): void {
		if (inputs.unsafePayload) {
			this.#anchor = undefined;
			this.#pending = undefined;
			return;
		}
		const tokenizer = this.tokenizer();
		const context = inputs.providerContext;
		const providerNonMessageTokens = this.#providerNonMessageTokens(context);
		this.#pending = {
			identity: inputs.identity,
			provider: inputs.provider,
			model: inputs.model,
			ratioKey: `${inputs.provider}\0${inputs.model}\0${inputs.ratioScope ?? ""}`,
			prefix: inputs.messages.map(fingerprint),
			providerPrefix: context.messages.map(fingerprint),
			systemPrompt: [...inputs.systemPrompt],
			toolsKey: inputs.toolsKey,
			nonMessageTokens: inputs.nonMessageTokens,
			providerSystemPrompt: [...(context.systemPrompt ?? [])],
			providerToolsKey: JSON.stringify([context.tools ?? [], context.inactiveTools ?? []]),
			providerNonMessageTokens,
			providerLocalTokens:
				providerNonMessageTokens + tokenizer.countMessages(context.messages, { excludeEncryptedReasoning: true }),
			inputLocalTokens:
				inputs.nonMessageTokens + tokenizer.countMessages(inputs.messages, { excludeEncryptedReasoning: true }),
		};
	}

	settle(message: AssistantMessage): void {
		const pending = this.#pending;
		this.#pending = undefined;
		if (
			!pending ||
			!isTranscriptUsageAnchor(message) ||
			pending.provider !== message.provider ||
			pending.model !== message.model
		)
			return;
		// Input certifies the dispatched prefix. A conversation occupancy checkpoint includes
		// the completed response, so only messages beyond that response may be added again.
		const usage = message.usage;
		const source = usage.contextTokens === undefined ? "prompt" : "occupancy";
		const measuredTokens = usage.contextTokens ?? usage.input + usage.cacheRead + usage.cacheWrite;
		if (!Number.isFinite(measuredTokens) || measuredTokens <= 0) return;
		if (source === "occupancy") {
			const tailTokens = this.tokenizer().countMessage(message, { excludeEncryptedReasoning: true });
			pending.prefix.push(fingerprint(message));
			pending.providerPrefix.push(fingerprint(message));
			pending.inputLocalTokens += tailTokens;
			pending.providerLocalTokens += tailTokens;
		}
		this.#anchor = {
			...pending,
			measuredTokens,
			source,
			provider: message.provider,
			model: message.model,
			timestamp: message.timestamp,
			ratio: Math.min(MAX_DRIFT_RATIO, Math.max(1, measuredTokens / Math.max(1, pending.providerLocalTokens))),
		};
	}

	estimate(inputs: ClmBudgetInputs): ClmBudgetEstimate {
		const tokenizer = this.tokenizer();
		const context = inputs.providerContext;
		const messages = context?.messages ?? inputs.messages;
		const nonMessageTokens = context ? this.#providerNonMessageTokens(context) : inputs.nonMessageTokens;
		const localRequestTokens =
			nonMessageTokens + tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
		const anchor = this.#anchor;
		let reason: ClmBudgetEstimate["usageAnchor"]["reason"] = "valid";
		if (inputs.unsafePayload) reason = "payload-hook";
		else if (inputs.allowAnchor === false) reason = "candidate";
		else if (!anchor) reason = "unmeasured";
		else if (anchor.identity !== inputs.identity) reason = "identity";
		else if (!prefixMatches(anchor.prefix, inputs.messages)) reason = "prefix";
		else if (anchor.toolsKey !== inputs.toolsKey || !promptExtends(anchor.systemPrompt, inputs.systemPrompt))
			reason = "framing";
		else if (context && !prefixMatches(anchor.providerPrefix, context.messages)) reason = "provider-prefix";
		else if (
			context &&
			(anchor.providerToolsKey !== JSON.stringify([context.tools ?? [], context.inactiveTools ?? []]) ||
				!promptExtends(anchor.providerSystemPrompt, context.systemPrompt ?? []))
		)
			reason = "framing";
		const valid = reason === "valid" && anchor !== undefined;
		const calibratedRequestTokens = valid
			? anchor.measuredTokens +
				Math.max(0, nonMessageTokens - (context ? anchor.providerNonMessageTokens : anchor.nonMessageTokens)) +
				tokenizer.countMessages(messages.slice(context ? anchor.providerPrefix.length : anchor.prefix.length), {
					excludeEncryptedReasoning: true,
				})
			: null;
		// Additions pay the observed drift. Deletions credit only their local size: the
		// excess may be additive provider framing, not drift belonging to the deleted text.
		const ratioScopeMatches =
			!valid &&
			anchor !== undefined &&
			!inputs.unsafePayload &&
			anchor.ratioKey === `${inputs.provider}\0${inputs.model}\0${inputs.ratioScope ?? ""}`;
		const localDelta = ratioScopeMatches
			? inputs.nonMessageTokens +
				tokenizer.countMessages(inputs.messages, { excludeEncryptedReasoning: true }) -
				anchor.inputLocalTokens
			: 0;
		const ratioAdjustedRequestTokens = ratioScopeMatches
			? anchor.measuredTokens + Math.ceil(localDelta * (localDelta > 0 ? anchor.ratio : 1))
			: null;
		const estimatedRequestTokens = Math.max(
			localRequestTokens,
			calibratedRequestTokens ?? 0,
			ratioAdjustedRequestTokens ?? 0,
		);
		const localExact = tokenizer.exact;
		const unmeasuredTokens =
			anchor !== undefined && (valid || ratioAdjustedRequestTokens !== null)
				? Math.max(0, estimatedRequestTokens - anchor.measuredTokens)
				: estimatedRequestTokens;
		return {
			localRequestTokens,
			localExact,
			calibratedRequestTokens,
			ratioAdjustedRequestTokens,
			estimatedRequestTokens,
			safetyMarginTokens:
				Math.ceil(unmeasuredTokens * (localExact ? EXACT_MARGIN_RATE : INEXACT_MARGIN_RATE)) + MARGIN_FLOOR_TOKENS,
			usageAnchor: {
				valid,
				reason: valid && anchor.source === "occupancy" ? "occupancy" : reason,
				source: anchor?.source ?? null,
				promptTokens: anchor?.source === "prompt" ? anchor.measuredTokens : null,
				occupancyTokens: anchor?.source === "occupancy" ? anchor.measuredTokens : null,
				provider: anchor?.provider ?? null,
				model: anchor?.model ?? null,
				timestamp: anchor?.timestamp ?? null,
			},
		};
	}
}
