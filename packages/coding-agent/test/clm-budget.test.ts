import { describe, expect, it } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, UserMessage } from "@oh-my-pi/pi-ai";
import { ClmBudgetTracker, type ClmBudgetInputs } from "../src/session/clm-budget";

function harness() {
	const tokenizer = new Tokenizer();
	const tracker = new ClmBudgetTracker(() => tokenizer);
	const messages: UserMessage[] = [{ role: "user", content: "Unchanged request history", timestamp: 1 }];
	const context: Context = { systemPrompt: ["System"], messages, tools: [] };
	const inputs: ClmBudgetInputs & { providerContext: Context } = {
		identity: "session:revision:model",
		provider: "mock",
		model: "m",
		messages,
		systemPrompt: ["System"],
		toolsKey: "tools",
		nonMessageTokens: tokenizer.countTokens("System"),
		providerContext: context,
	};
	const response: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Generated answer" }],
		api: "mock",
		provider: "mock",
		model: "m",
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: 300_000,
			cacheRead: 100_000,
			cacheWrite: 15_430,
			output: 99_999,
			totalTokens: 515_429,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	tracker.capture(inputs);
	tracker.settle(response);
	return { tokenizer, tracker, inputs, response };
}

describe("CLM provider input anchors", () => {
	it("uses measured input and caches, never output, when full local history undercounts", () => {
		const { tracker, inputs } = harness();
		const budget = tracker.estimate(inputs);
		expect(budget.localRequestTokens).toBeLessThan(100);
		expect(budget.calibratedRequestTokens).toBe(415_430);
		expect(budget.estimatedRequestTokens).toBe(415_430);
		expect(budget.usageAnchor.valid).toBe(true);
	});

	it("adds only new assistant/user tail and append-only non-message growth", () => {
		const { tracker, inputs, tokenizer, response } = harness();
		const tail: Array<AssistantMessage | UserMessage> = [
			response,
			{ role: "user", content: "Next request", timestamp: 3 },
		];
		const context: Context = {
			...inputs.providerContext,
			messages: [...inputs.providerContext.messages, ...tail],
			systemPrompt: ["System", "New system context"],
		};
		const budget = tracker.estimate({
			...inputs,
			messages: [...inputs.messages, ...tail],
			systemPrompt: context.systemPrompt!,
			providerContext: context,
		});
		expect(budget.calibratedRequestTokens).toBe(
			415_430 +
				tokenizer.countMessages(tail, { excludeEncryptedReasoning: true }) +
				tokenizer.countTokens("New system context"),
		);
	});

	it("bounds a rewritten request by the old measurement, but never across conversation scopes", () => {
		const { tracker, inputs, response } = harness();
		const rewritten = { ...inputs, identity: "new-revision", messages: [...inputs.messages, response] };
		const budget = tracker.estimate(rewritten);
		expect(budget.usageAnchor).toMatchObject({ valid: false, reason: "identity" });
		expect(budget.calibratedRequestTokens).toBeNull();
		// An additive rewrite cannot fall below what the provider already measured.
		expect(budget.ratioAdjustedRequestTokens).toBeGreaterThan(415_430);
		expect(budget.ratioAdjustedRequestTokens).toBe(budget.estimatedRequestTokens);
		const replaced = tracker.estimate({ ...rewritten, ratioScope: "other-conversation" });
		expect(replaced.ratioAdjustedRequestTokens).toBeNull();
		expect(replaced.estimatedRequestTokens).toBe(replaced.localRequestTokens);
	});

	it("never certifies edited candidates or changed raw prefixes", () => {
		const { tracker, inputs } = harness();
		expect(tracker.estimate({ ...inputs, allowAnchor: false }).calibratedRequestTokens).toBeNull();
		const changed: AgentMessage[] = [{ role: "user", content: "Edited request", timestamp: 1 }];
		expect(tracker.estimate({ ...inputs, messages: changed }).usageAnchor).toMatchObject({
			valid: false,
			reason: "prefix",
		});
	});

	it("invalidates prepared-provider rewrites independently of unchanged raw history", () => {
		const { tracker, inputs } = harness();
		const providerContext: Context = {
			...inputs.providerContext,
			messages: [{ role: "user", content: "Provider transform replaced prefix", timestamp: 1 }],
		};
		expect(tracker.estimate({ ...inputs, providerContext }).usageAnchor).toMatchObject({
			valid: false,
			reason: "provider-prefix",
		});
	});

	it("invalidates replaced system prompts, host schemas and outgoing inactive schemas", () => {
		const { tracker, inputs } = harness();
		for (const change of [
			{ systemPrompt: ["Changed system"] },
			{ toolsKey: "changed schema" },
			{
				providerContext: {
					...inputs.providerContext,
					inactiveTools: [{ name: "old", description: "schema", parameters: { type: "object" } }],
				},
			},
		])
			expect(tracker.estimate({ ...inputs, ...change }).usageAnchor).toMatchObject({
				valid: false,
				reason: "framing",
			});
	});

	it("requires a new measured request after rewrite rather than carrying the old discrepancy", () => {
		const { tracker, inputs, response } = harness();
		const revised = { ...inputs, identity: "new-revision" };
		expect(tracker.estimate(revised).calibratedRequestTokens).toBeNull();
		tracker.capture(revised);
		tracker.settle({ ...response, usage: { ...response.usage, input: 37_059, cacheRead: 0, cacheWrite: 0 } });
		expect(tracker.estimate(revised).estimatedRequestTokens).toBe(37_059);
	});

	it("rejects calibration for arbitrary payload hooks and requires remeasurement after they retire", () => {
		const { tracker, inputs, response } = harness();
		const custom = { ...inputs, unsafePayload: true };
		expect(tracker.estimate(custom).usageAnchor).toMatchObject({ valid: false, reason: "payload-hook" });
		tracker.capture(custom);
		tracker.settle(response);
		expect(tracker.estimate(inputs).calibratedRequestTokens).toBeNull();
		tracker.capture(inputs);
		tracker.settle(response);
		expect(tracker.estimate(inputs).usageAnchor.valid).toBe(true);
	});

	it("does not credit deletions with provider drift that may be additive framing", () => {
		const { tracker, inputs, response, tokenizer } = harness();
		const large: UserMessage = { role: "user", content: "x".repeat(40_000), timestamp: 1 };
		const measured = {
			...inputs,
			messages: [large],
			providerContext: { ...inputs.providerContext, messages: [large] },
		};
		tracker.capture(measured);
		tracker.settle({ ...response, usage: { ...response.usage, input: 40_000, cacheRead: 0, cacheWrite: 0 } });
		const small: UserMessage = { role: "user", content: "Kept", timestamp: 1 };
		const revised = {
			...measured,
			messages: [small],
			providerContext: { ...measured.providerContext, messages: [small] },
		};
		const budget = tracker.estimate(revised);
		expect(budget.ratioAdjustedRequestTokens).toBe(
			40_000 - tokenizer.countMessage(large) + tokenizer.countMessage(small),
		);
		expect(budget.estimatedRequestTokens).toBeGreaterThanOrEqual(30_000);
	});
	it("anchors occupancy after the completed response without double-counting generated output", () => {
		const { tracker, inputs, response, tokenizer } = harness();
		const completed = { ...response, usage: { ...response.usage, contextTokens: 10_000 } };
		tracker.capture(inputs);
		tracker.settle(completed);
		const next: UserMessage = { role: "user", content: "Next request", timestamp: 3 };
		const messages = [...inputs.messages, completed, next];
		const budget = tracker.estimate({
			...inputs,
			messages,
			providerContext: {
				...inputs.providerContext,
				messages: [...inputs.providerContext.messages, completed, next],
			},
		});
		expect(budget.calibratedRequestTokens).toBe(10_000 + tokenizer.countMessage(next));
		expect(budget.usageAnchor).toMatchObject({
			valid: true,
			reason: "occupancy",
			source: "occupancy",
			promptTokens: null,
			occupancyTokens: 10_000,
		});
		expect(tracker.estimate(inputs).usageAnchor.valid).toBe(false);
	});
	it("does not import retained usage, failed requests or output-only reports", () => {
		const { inputs, response, tokenizer } = harness();
		for (const usage of [response.usage, { ...response.usage, input: 0, cacheRead: 0, cacheWrite: 0 }]) {
			const tracker = new ClmBudgetTracker(() => tokenizer);
			tracker.settle({ ...response, usage });
			expect(tracker.estimate({ ...inputs, messages: [...inputs.messages, response] }).usageAnchor.valid).toBe(
				false,
			);
			tracker.capture(inputs);
			tracker.settle({ ...response, usage, stopReason: "aborted" });
			expect(tracker.estimate(inputs).calibratedRequestTokens).toBeNull();
		}
		const tracker = new ClmBudgetTracker(() => tokenizer);
		tracker.capture(inputs);
		tracker.settle({ ...response, usage: { ...response.usage, input: 0, cacheRead: 0, cacheWrite: 0 } });
		expect(tracker.estimate(inputs).usageAnchor.valid).toBe(false);
	});
});
