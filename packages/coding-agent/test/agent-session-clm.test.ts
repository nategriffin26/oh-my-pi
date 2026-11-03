import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as judgment from "@oh-my-pi/pi-coding-agent/judgment";
import {
	cfgCompactionClmRecallRerank,
	cfgCompactionExperimentalClm,
	cfgCompactionExperimentalContextManagement,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface EditableDocument {
	blocks: Array<{ id?: string; text: string; protected?: boolean; opaque?: boolean }>;
}

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

async function harness() {
	const dir = TempDir.createSync("omp-clm-loop-");
	const manager = SessionManager.create(dir.path(), dir.path());
	const old: AgentMessage = { role: "user", content: "DISCARD_OLD_NOISE", timestamp: 1 };
	manager.appendMessage(old);
	let effects = 0;

	const schema = type({});
	const tools: AgentTool[] = [
		{
			name: "rewrite_context",
			label: "Rewrite context",
			description: "Rewrite completed context",
			parameters: schema,
			execute: async toolCallId => {
				const capability = session.getClmContext();
				const document = JSON.parse((await capability.read({ kind: "document" })).text) as EditableDocument;
				document.blocks = document.blocks.filter(block => !block.text.includes("DISCARD_OLD_NOISE"));
				document.blocks.unshift({ text: "Working state: EXACT_NEEDLE_738" });
				const receipt = await capability.stage(JSON.stringify(document), toolCallId);
				return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
			},
		},
		{
			name: "side_effect",
			label: "Side effect",
			description: "Record one external effect",
			parameters: schema,
			execute: async () => {
				effects++;
				return { content: [{ type: "text", text: "SIBLING_RESULT_PRESERVED" }] };
			},
		},
	];
	const mock = createMockModel({
		responses: [
			{
				content: [
					{ type: "toolCall", id: "edit-1", name: "rewrite_context", arguments: {} },
					{ type: "toolCall", id: "effect-1", name: "side_effect", arguments: {} },
				],
				stopReason: "toolUse",
			},
			{ content: ["COMPLETE"] },
		],
	});
	const settings = Settings.isolated({
		"compaction.experimentalClm": true,
		"compaction.enabled": true,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: mock.stream,
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [old] },
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
	return { session, manager, mock, settings, effects: () => effects };
}

describe("CLM execution boundary", () => {
	it("rewrites the next provider request without rerunning sibling tools or losing their durable results", async () => {
		const { session, manager, mock, effects, settings } = await harness();
		await session.prompt("CURRENT_USER_REQUIREMENT: retain EXACT_NEEDLE_738");
		await session.waitForIdle();

		const nextRequest = JSON.stringify(mock.calls[1]?.context.messages);
		expect(nextRequest).not.toContain(JSON.stringify("DISCARD_OLD_NOISE"));
		expect(nextRequest).toContain("EXACT_NEEDLE_738");
		expect(nextRequest).toContain("CURRENT_USER_REQUIREMENT");
		expect(nextRequest).toContain("SIBLING_RESULT_PRESERVED");
		expect(effects()).toBe(1);
		expect(mock.calls).toHaveLength(2);
		const projection = manager.getLatestContextProjection();
		expect(projection?.cause).toBe("edit");
		const branch = manager.getBranch();
		const boundary = branch.findIndex(entry => entry.type === "context_projection");
		expect(
			branch
				.slice(0, boundary)
				.filter(entry => entry.type === "message" && entry.message.role === "toolResult")
				.map(entry =>
					entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolCallId : "",
				)
				.sort(),
		).toEqual(["edit-1", "effect-1"]);
		expect(JSON.stringify(manager.getEntries())).toContain("DISCARD_OLD_NOISE");
		await manager.flush();
		const restored = await SessionManager.open(manager.getSessionFile()!);
		expect(JSON.stringify(restored.buildSessionContext().messages)).not.toContain(
			JSON.stringify("DISCARD_OLD_NOISE"),
		);
		expect(JSON.stringify(restored.buildSessionContext().messages)).toContain("SIBLING_RESULT_PRESERVED");
		cfgCompactionExperimentalClm.set(settings, false);
		expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(JSON.stringify("DISCARD_OLD_NOISE"));
	});

	it("rejects a stale edit after a newer accepted revision", async () => {
		const { session } = await harness();
		const before = (await session.getClmContext().read({ kind: "document" })).text;
		await session.prompt("CURRENT_USER_REQUIREMENT: retain EXACT_NEEDLE_738");
		await session.waitForIdle();
		await expect(session.getClmContext().stage(before, "stale-writer")).rejects.toThrow("snapshot");
		expect(JSON.stringify(session.messages)).not.toContain(JSON.stringify("DISCARD_OLD_NOISE"));
	});
	it("refuses competing management modes before edits or provider dispatch without changing settings", async () => {
		const { session, settings, mock, manager } = await harness();
		const document = (await session.getClmContext().read({ kind: "document" })).text;
		cfgCompactionExperimentalContextManagement.set(settings, true);
		await expect(session.getClmContext().stage(document, "conflict")).rejects.toThrow("mutually exclusive");
		await session.prompt("Keep the current history unchanged");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(0);
		expect(manager.getLatestContextProjection()).toBeUndefined();
		expect(cfgCompactionExperimentalClm.get(settings)).toBe(true);
		expect(cfgCompactionExperimentalContextManagement.get(settings)).toBe(true);
	});
	it("halts over-capacity protected input before provider dispatch without dropping the human request", async () => {
		const { session, mock, effects, manager } = await harness();
		session.agent.setModel({ ...mock, contextWindow: 1024 });
		const request = "PROTECTED_LONG_REQUIREMENT ".repeat(1000);
		await session.prompt(request);
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(0);
		expect(effects()).toBe(0);
		expect(manager.getLatestContextProjection()).toBeUndefined();
		expect(JSON.stringify(session.messages)).toContain(request.trim());
	});
	it("rejects note growth that exceeds the window before staging a revision", async () => {
		const { session, mock, manager } = await harness();
		session.agent.setModel({ ...mock, contextWindow: 1024 });
		const document = JSON.parse((await session.getClmContext().read({ kind: "document" })).text) as EditableDocument;
		document.blocks.push({ text: "MODEL_AUTHORED_WORKING_STATE ".repeat(1000) });
		await expect(session.getClmContext().stage(JSON.stringify(document), "oversized-note")).rejects.toThrow(
			/does not fit the context window/,
		);
		expect(manager.getLatestContextProjection()).toBeUndefined();
		expect(JSON.stringify(session.messages)).not.toContain("MODEL_AUTHORED_WORKING_STATE");
	});
});

describe("CLM recall rerank setting", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps archive search lexical without resolving the native judge while recall is lexical", async () => {
		const { session, settings } = await harness();
		vi.spyOn(judgment, "hasNativeJudge").mockReturnValue(true);
		const offline = {
			judge: async () => {
				throw new Error("judge offline in test");
			},
		};
		const resolve = vi
			.spyOn(judgment, "resolveJudge")
			.mockImplementation(() => offline as unknown as judgment.ChainJudge);
		const search = { kind: "archive-search", query: "DISCARD_OLD_NOISE", regex: false, rerank: true } as const;

		cfgCompactionClmRecallRerank.set(settings, "lexical");
		await session.getClmContext().read(search);
		expect(resolve).not.toHaveBeenCalled();

		cfgCompactionClmRecallRerank.set(settings, "jev");
		await session.getClmContext().read(search);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("honors a child's lexical policy on parent archive searches even with rerank=1", async () => {
		const { session, settings } = await harness();
		cfgCompactionClmRecallRerank.set(settings, "jev");
		vi.spyOn(judgment, "hasNativeJudge").mockReturnValue(true);
		const offline = {
			judge: async () => {
				throw new Error("judge offline in test");
			},
		};
		const resolve = vi
			.spyOn(judgment, "resolveJudge")
			.mockImplementation(() => offline as unknown as judgment.ChainJudge);
		const access = session.getClmContext();
		const manager = SessionManager.inMemory("/repo");
		const child: ToolSession = {
			cwd: "/repo",
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => manager.getSessionId(),
			sessionManager: manager,
			parentClmArchive: { access, ownerSessionId: access.ownerSessionId, excludeKinds: [] },
		};
		cfgCompactionClmRecallRerank.set(child.settings, "lexical");
		const router = new InternalUrlRouter();
		const url = "context://parent/archive?q=DISCARD_OLD_NOISE&rerank=1";
		const lexical = await router.resolve(url, { session: child });
		expect(lexical.content).toContain("DISCARD_OLD_NOISE");
		expect(resolve).not.toHaveBeenCalled();
		cfgCompactionClmRecallRerank.set(child.settings, "jev");
		await router.resolve(url, { session: child });
		expect(resolve).toHaveBeenCalledTimes(1);
	});
});
