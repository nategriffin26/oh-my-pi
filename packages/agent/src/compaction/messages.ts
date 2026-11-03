import type {
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";
import branchSummaryContextPrompt from "./prompts/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "./prompts/compaction-summary-context.md" with { type: "text" };
import handoffSummaryContextPrompt from "./prompts/handoff-summary-context.md" with { type: "text" };
import clmNoteContextPrompt from "./prompts/clm-note-context.md" with { type: "text" };

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const HANDOFF_SUMMARY_TEMPLATE = handoffSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Legacy hook message type (pre-extensions). Kept for session migration. */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Model-authored historical data; never developer authority. */
export interface ClmNoteMessage {
	role: "clmNote";
	/** Raw model-authored text; empty only for a host rewrite marker carrying `historyRewriteAt`. */
	content: string;
	historyRewriteAt?: number;
	timestamp: number;
}

/** Host-written CLM history-rewrite marker: no model text, only the rewrite time. */
export function isClmRewriteMarker(message: AgentMessage | undefined): message is ClmNoteMessage & {
	historyRewriteAt: number;
} {
	return message?.role === "clmNote" && message.content === "" && message.historyRewriteAt !== undefined;
}

/**
 * Rewrite time an empty CLM marker run hands to `messages[index]` during array conversion.
 *
 * Markers never send their own boilerplate: a run of consecutive markers folds its max
 * `historyRewriteAt` onto the next message when that lowers to a user message, so provider
 * bound-thinking invalidation and usage-anchor staleness still start at the marker position.
 * Only when the run is followed by anything else (e.g. an assistant whose bound thinking the
 * rewrite invalidates) does its last marker return the time so it is sent as a minimal carrier.
 * A trailing run has nothing after it to invalidate and emits nothing.
 */
export function clmRewriteCarry(messages: readonly AgentMessage[], index: number): number | undefined {
	const message = messages[index];
	let run = index - 1;
	if (isClmRewriteMarker(message)) {
		const next = messages[index + 1];
		// A later marker of the run, or the user/note message after it, carries the time.
		if (next === undefined || next.role === "clmNote" || next.role === "user") return undefined;
		run = index;
	} else if (message.role !== "user" && message.role !== "clmNote") {
		return undefined;
	}
	let rewriteAt: number | undefined;
	for (let i = run; i >= 0; i--) {
		const marker = messages[i];
		if (!isClmRewriteMarker(marker)) break;
		rewriteAt = Math.max(rewriteAt ?? marker.historyRewriteAt, marker.historyRewriteAt);
	}
	return rewriteAt;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	/** Estimated context tokens after the rewrite (display metadata). */
	tokensAfter?: number;
	/** Harness compaction method that produced this summary (display metadata). */
	method?: string;
	providerPayload?: ProviderPayload;
	/** Runtime-only ordered archive blocks for snapcompact: old text region,
	 *  imaged middle, then new text region. When present, `summary` is already
	 *  the final lead-in text (no legacy wrapper applied). */
	blocks?: (TextContent | ImageContent)[];
	/** Snapcompact image blocks, kept for display counts / legacy consumers. */
	images?: ImageContent[];
	/** Post-pass dead-end warning attached to this compaction (progress guard). */
	warning?: string;
	/**
	 * Thinking-binding rewrite marker when it must differ from `timestamp`: a
	 * natively replayed summary predates it before the retained tail so that
	 * tail's bound thinking stays valid. `timestamp` remains the commit time,
	 * which is what invalidates the tail's pre-compaction usage reports.
	 */
	historyRewriteAt?: number;
	timestamp: number;
}

export type CoreCompactionMessage =
	| CustomMessage
	| HookMessage
	| BranchSummaryMessage
	| CompactionSummaryMessage
	| ClmNoteMessage;

declare module "../types" {
	interface CustomAgentMessages {
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		clmNote: ClmNoteMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	const firstTextIndex = message.content.findIndex(content => content.type === "text");
	if (firstTextIndex < 0) return [{ type: "text", text }, ...message.content];

	const content: (TextContent | ImageContent)[] = [];
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block.type !== "text") content.push(block);
		else if (index === firstTextIndex) content.push({ type: "text", text });
	}
	return content;
}

export function renderBranchSummaryContext(summary: string): string {
	return prompt.render(BRANCH_SUMMARY_TEMPLATE, { summary });
}

export function renderCompactionSummaryContext(summary: string): string {
	return prompt.render(COMPACTION_SUMMARY_TEMPLATE, { summary });
}
/**
 * Wrap a handoff document for injection into the successor context. Unlike the
 * generic compaction wrapper, this names the mechanism and pins authorship —
 * the document was written by a prior instance in its own voice, so without
 * this framing the successor misreads first-person "Next Steps" as fresh user
 * instructions (or tries to write the handoff again).
 */
export function renderHandoffSummaryContext(summary: string): string {
	return prompt.render(HANDOFF_SUMMARY_TEMPLATE, { summary });
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Optional metadata for {@link createCompactionSummaryMessage}. */
export interface CompactionSummaryMessageOptions {
	shortSummary?: string;
	providerPayload?: ProviderPayload;
	images?: ImageContent[];
	blocks?: (TextContent | ImageContent)[];
	warning?: string;
	/** Harness compaction method that produced this summary (e.g. "remote", "soft", "handoff"). */
	method?: string;
	/** Estimated context tokens after the rewrite, for display alongside `tokensBefore`. */
	tokensAfter?: number;
	/** See {@link CompactionSummaryMessage.historyRewriteAt}. */
	historyRewriteAt?: number;
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	options: CompactionSummaryMessageOptions = {},
): CompactionSummaryMessage {
	const { shortSummary, providerPayload, images, blocks, warning, method, tokensAfter, historyRewriteAt } = options;
	const imageBlocks =
		blocks?.filter((block): block is ImageContent => block.type === "image") ??
		(images && images.length > 0 ? images : undefined);
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		tokensAfter,
		method,
		providerPayload,
		blocks: blocks && blocks.length > 0 ? blocks : undefined,
		images: imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined,
		warning,
		historyRewriteAt,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

function isCoreCompactionMessage(message: AgentMessage): message is AgentMessage & CoreCompactionMessage {
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "clmNote" ||
		message.role === "compactionSummary"
	);
}

/**
 * Transform a single core-domain agent message to its LLM form; `undefined`
 * drops it from the provider request.
 *
 * Single source of truth for the core roles (user/developer/assistant/
 * toolResult) and the compaction messages owned by this package. Embedders
 * with their own app messages (e.g. the coding agent) handle their custom
 * roles and delegate every core role here — duplicating these cases is how
 * snapcompact frames once silently fell off the provider request.
 *
 * `rewriteAt` is the CLM marker time {@link clmRewriteCarry} assigns to this
 * position; without it an empty CLM rewrite marker emits nothing.
 */
export function convertMessageToLlm(message: AgentMessage, rewriteAt?: number): Message | undefined {
	if (isCoreCompactionMessage(message)) {
		switch (message.role) {
			case "clmNote":
				if (isClmRewriteMarker(message)) {
					if (rewriteAt === undefined) return undefined;
					return {
						role: "user",
						content: [{ type: "text", text: "[CLM: earlier context was rewritten here.]" }],
						attribution: "agent",
						historyRewriteAt: rewriteAt,
						timestamp: message.timestamp,
					};
				}
				return {
					role: "user",
					// Escaped so model-authored text cannot close the host trust envelope; persisted bytes stay raw.
					content: [
						{
							type: "text",
							text: prompt.render(clmNoteContextPrompt, { content: escapeXmlText(message.content) }),
						},
					],
					attribution: "agent",
					historyRewriteAt:
						rewriteAt === undefined
							? message.historyRewriteAt
							: Math.max(rewriteAt, message.historyRewriteAt ?? rewriteAt),
					timestamp: message.timestamp,
				};
			case "custom":
			case "hookMessage": {
				const content =
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content;
				return {
					role: "developer",
					content,
					attribution: message.attribution,
					timestamp: message.timestamp,
				};
			}
			case "branchSummary":
				return {
					role: "user",
					content: [
						{
							type: "text" as const,
							text: renderBranchSummaryContext(message.summary),
						},
					],
					attribution: "agent",
					historyRewriteAt: message.timestamp,
					timestamp: message.timestamp,
				};
			case "compactionSummary":
				return {
					role: "user",
					content:
						message.blocks !== undefined
							? [{ type: "text" as const, text: message.summary }, ...message.blocks]
							: [
									{
										type: "text" as const,
										text:
											message.method === "handoff"
												? renderHandoffSummaryContext(message.summary)
												: renderCompactionSummaryContext(message.summary),
									},
									...(message.images ?? []),
								],
					attribution: "agent",
					historyRewriteAt: message.historyRewriteAt ?? message.timestamp,
					providerPayload: message.providerPayload,
					timestamp: message.timestamp,
				};
		}
	}

	switch (message.role) {
		case "user":
			return rewriteAt === undefined
				? { ...message, attribution: message.attribution ?? "user" }
				: {
						...message,
						attribution: message.attribution ?? "user",
						historyRewriteAt: Math.max(rewriteAt, message.historyRewriteAt ?? rewriteAt),
					};
		case "developer":
			return { ...message, attribution: message.attribution ?? "agent" };
		case "assistant":
			return message;
		case "toolResult":
			return {
				...message,
				content: getPrunedToolResultContent(message as ToolResultMessage),
				attribution: message.attribution ?? "agent",
			};
		default:
			return undefined;
	}
}

/**
 * Default compaction-domain transformer.
 *
 * Embedders with their own app messages should pass a richer transformer through
 * `SummaryOptions.convertToLlm`; this default intentionally preserves only the
 * core LLM roles and the compaction messages owned by this package.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((message, index) => convertMessageToLlm(message, clmRewriteCarry(messages, index)))
		.filter(message => message !== undefined);
}
