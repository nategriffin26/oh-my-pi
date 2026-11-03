import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { cfgCompactionExperimentalClm, cfgCompactionEnabled } from "../src/session/context-settings";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

let auth: AuthStorage;
let registry: ModelRegistry;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
	auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("mock", "test-key");
	registry = new ModelRegistry(auth);
});
afterAll(() => auth.close());
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(responses: MockHandler[], tools: AgentTool[] = [], contextWindow = 200_000) {
	const dir = TempDir.createSync("@clm-budget-session-");
	const manager = SessionManager.create(dir.path(), dir.path());
	const old: AgentMessage = { role: "user", content: "OLD_HISTORY_TO_REWRITE", timestamp: 1 };
	manager.appendMessage(old);
	const mock = createMockModel({ responses, contextWindow });
	const settings = Settings.isolated({
		"compaction.experimentalClm": true,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: mock.stream,
		initialState: { model: mock, systemPrompt: ["System"], tools, messages: [old] },
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: registry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	cleanups.push(async () => {
		await session.dispose();
		dir.removeSync();
	});
	return { session, mock, manager, settings };
}

async function status(session: AgentSession) {
	return JSON.parse((await session.getClmContext().read({ kind: "status" })).text);
}

describe("CLM calibrated capacity at session boundaries", () => {
	it("fits the capped reply after adding feedback to the dispatched prompt", async () => {
		const { session, mock } = await harness(
			[{ content: ["Measured"], usage: { input: 100_000 } }, { content: ["Capped"] }],
			[],
			120_000,
		);
		await session.prompt("Measure");
		await session.waitForIdle();
		let finalInput = 0;
		session.agent.addBeforeModelCall(context => {
			const tail = session.agent.tokenizer.countMessages(
				context.messages.slice(mock.calls[0].context.messages.length),
				{ excludeEncryptedReasoning: true },
			);
			finalInput = 100_000 + tail + Math.ceil(tail * 0.25) + 64;
		});
		await session.prompt("Next");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		expect(finalInput + mock.calls[1].options!.maxTokens!).toBeLessThanOrEqual(120_000);
	});
	it("announces the actual cap without claiming a below-soft-line request crossed it", async () => {
		const { session, mock } = await harness([{ content: ["Capped"] }], [], 100_000);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "clm") notices.push(event.message);
		});
		await session.prompt("x".repeat(280_000));
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		const urgent = notices.filter(notice => notice.startsWith("CLM urgent:"));
		expect(urgent).toHaveLength(1);
		expect(urgent[0]).not.toContain("is past the configured context-management limit");
		const announced = Number(/Only (\d+) of \d+ reply tokens still fit/.exec(urgent[0])?.[1]);
		expect(mock.calls[0].options?.maxTokens).toBe(announced);
		expect(JSON.stringify(mock.calls[0].context.messages)).toContain(`Only ${announced} of`);
	});
	it("stops enforcing CLM capacity when disabled after a durable projection", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const rewrite: AgentTool = {
			name: "rewrite",
			label: "rewrite",
			description: "Rewrite history",
			parameters: type({}),
			execute: async () => {
				const document = JSON.parse((await sessionRef.current!.getClmContext().read({ kind: "document" })).text);
				document.blocks = document.blocks.filter(
					(block: { text: string }) => !block.text.includes("OLD_HISTORY_TO_REWRITE"),
				);
				await sessionRef.current!.getClmContext().stage(JSON.stringify(document), "rewrite-disabled");
				return { content: [{ type: "text", text: "Rewritten" }] };
			},
		};
		const h = await harness(
			[
				{
					content: [{ type: "toolCall", id: "rewrite-disabled", name: "rewrite", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["Measured"], usage: { input: 118_000 } },
				{ content: ["CLM disabled reply"] },
			],
			[rewrite],
			120_000,
		);
		const session = h.session;
		sessionRef.current = session;
		await session.prompt("Rewrite");
		await session.waitForIdle();
		expect(h.manager.getLatestContextProjection()).toBeDefined();
		cfgCompactionExperimentalClm.override(h.settings, false);
		cfgCompactionEnabled.override(h.settings, false);
		await session.prompt("Normal request");
		await session.waitForIdle();
		expect(h.mock.calls).toHaveLength(3);
		expect(JSON.stringify(h.mock.calls[2].context.messages)).toContain("Normal request");
	});
	it("bases urgency on the rescued request, not the removed unseen output", async () => {
		const tool: AgentTool = {
			name: "huge",
			label: "huge",
			description: "Read output",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "UNSEEN_OUTPUT ".repeat(30_000) }] }),
		};
		const { session, mock, manager } = await harness(
			[
				{ content: [{ type: "toolCall", id: "huge-1", name: "huge", arguments: {} }], stopReason: "toolUse" },
				{ content: ["Rescued"] },
			],
			[tool],
			20_000,
		);
		await session.prompt("Small request");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		expect(manager.getLatestContextProjection()?.cause).toBe("spill");
		expect(JSON.stringify(mock.calls[1].context.messages)).not.toContain("CLM urgent:");
	});
	it("durably spills unseen results even when protected input still cannot fit", async () => {
		let effects = 0;
		const tool: AgentTool = {
			name: "huge",
			label: "huge",
			description: "Read output",
			parameters: type({}),
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "UNSEEN_OUTPUT ".repeat(30_000) }] };
			},
		};
		const { session, mock, manager } = await harness(
			[
				{
					content: [{ type: "toolCall", id: "huge-1", name: "huge", arguments: {} }],
					stopReason: "toolUse",
					usage: { input: 19_000 },
				},
			],
			[tool],
			20_000,
		);
		await session.prompt("Protected request");
		await session.waitForIdle();
		expect(effects).toBe(1);
		expect(mock.calls).toHaveLength(1);
		expect(manager.getLatestContextProjection()?.cause).toBe("spill");
		expect(JSON.stringify(session.messages)).toContain("artifact://");
		expect(JSON.stringify(session.messages)).toContain("CLM request does not fit the context window");
		await manager.flush();
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getLatestContextProjection()?.cause).toBe("spill");
	});
	it("blocks the next request using provider input instead of a much smaller local count", async () => {
		const { session, mock } = await harness(
			[{ content: ["Measured response"], usage: { input: 118_000 } }, { content: ["Should not run"] }],
			[],
			120_000,
		);
		await session.prompt("First small input");
		await session.waitForIdle();
		const budget = await status(session);
		expect(budget.usageAnchor.valid).toBe(true);
		expect(budget.estimatedRequestTokens).toBeGreaterThanOrEqual(118_000);
		expect(budget.localRequestTokens).toBeLessThan(1000);
		expect(session.getContextUsage()?.tokens).toBe(budget.estimatedRequestTokens);
		await session.prompt("Second protected input");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(JSON.stringify(session.messages)).toContain("Second protected input");
		expect(JSON.stringify(session.messages)).toContain("CLM request does not fit the context window");
	});

	it("caps the reply instead of refusing when only the configured output no longer fits", async () => {
		const { session, mock } = await harness(
			[{ content: ["Measured response"], usage: { input: 100_000 } }, { content: ["Capped reply"] }],
			[],
			120_000,
		);
		await session.prompt("First small input");
		await session.waitForIdle();
		await session.prompt("Second input");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		const maxTokens = mock.calls[1].options?.maxTokens ?? Number.POSITIVE_INFINITY;
		expect(maxTokens).toBeLessThan(20_000);
		expect(maxTokens).toBeGreaterThanOrEqual(4096);
		expect(JSON.stringify(mock.calls[1].context.messages)).toContain("CLM urgent");
	});

	it("drops calibration for changed models and reset history", async () => {
		const { session, mock } = await harness([{ content: ["Measured"], usage: { input: 80_000 } }]);
		await session.prompt("Measure this request");
		await session.waitForIdle();
		expect((await status(session)).usageAnchor.valid).toBe(true);
		session.agent.setModel({ ...mock, id: "other-model" });
		expect((await status(session)).calibratedRequestTokens).toBeNull();
		session.agent.setModel(mock);
		await session.resetSessionContext();
		const reset = await status(session);
		expect(reset.calibratedRequestTokens).toBeNull();
		expect(reset.estimatedRequestTokens).toBe(reset.localRequestTokens);
	});

	it("fits rewritten candidates locally, replaces anchors after commit, and invalidates restore", async () => {
		let afterStage: Awaited<ReturnType<typeof status>> | undefined;
		const rewrite: AgentTool = {
			name: "rewrite",
			label: "rewrite",
			description: "Rewrite old history",
			parameters: type({}),
			execute: async () => {
				const document = JSON.parse((await session.getClmContext().read({ kind: "document" })).text);
				document.blocks = document.blocks.filter(
					(block: { text: string }) => !block.text.includes("OLD_HISTORY_TO_REWRITE"),
				);
				document.blocks.unshift({ text: "New durable working state" });
				await session.getClmContext().stage(JSON.stringify(document), "rewrite-1");
				afterStage = await status(session);
				return { content: [{ type: "text", text: "Rewritten" }] };
			},
		};
		const h = await harness(
			[
				{
					content: [{ type: "toolCall", id: "edit", name: "rewrite", arguments: {} }],
					usage: { input: 190_000 },
					stopReason: "toolUse",
				},
				{ content: ["Finished"], usage: { input: 37_059 } },
			],
			[rewrite],
			200_000,
		);
		const session = h.session;
		await session.prompt("Preserve current request");
		await session.waitForIdle();
		expect(afterStage?.usageAnchor.valid).toBe(true);
		expect(afterStage?.estimatedRequestTokens).toBeGreaterThanOrEqual(190_000);
		expect(h.mock.calls).toHaveLength(2);
		expect(JSON.stringify(h.mock.calls[1].context.messages)).not.toContain(JSON.stringify("OLD_HISTORY_TO_REWRITE"));
		const committed = await status(session);
		expect(committed.usageAnchor.valid).toBe(true);
		expect(committed.usageAnchor.promptTokens).toBe(37_059);
		expect(committed.estimatedRequestTokens).toBeLessThan(40_000);
		await session.restoreClmContext(h.manager.getLatestContextProjection()!.id);
		const restored = await status(session);
		expect(restored.usageAnchor.valid).toBe(false);
		expect(restored.calibratedRequestTokens).toBeNull();
		// The restored history is bounded by the last measurement plus its local change, never the raw local count alone.
		expect(restored.estimatedRequestTokens).toBe(
			Math.max(restored.localRequestTokens, restored.ratioAdjustedRequestTokens),
		);
	});
});
