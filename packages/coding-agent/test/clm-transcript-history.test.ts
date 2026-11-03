import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { resolveClmHistory } from "@oh-my-pi/pi-coding-agent/session/clm-history";
import type { ClmReceipt } from "@oh-my-pi/pi-coding-agent/session/clm-types";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

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
	await Settings.init({ inMemory: true });
	await initTheme();
});
afterAll(() => auth.close());
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function editedSession(options: { invalidateDraft?: boolean; settings?: Record<string, unknown> } = {}) {
	const dir = TempDir.createSync("omp-clm-transcript-");
	const manager = SessionManager.create(dir.path(), dir.path());
	const old: AgentMessage = { role: "user", content: "DISCARD_OLD_NOISE", timestamp: 1 };
	const kept: AgentMessage = { role: "user", content: "KEEP_THIS_REQUIREMENT", timestamp: 2 };
	manager.appendMessage(old);
	manager.appendMessage(kept);
	const tools: AgentTool[] = [
		{
			name: "rewrite_context",
			label: "Rewrite context",
			description: "Rewrite completed context",
			parameters: type({}),
			execute: async toolCallId => {
				const capability = session.getClmContext();
				const document = JSON.parse((await capability.read({ kind: "document" })).text) as EditableDocument;
				document.blocks = document.blocks.filter(block => !block.text.includes("DISCARD_OLD_NOISE"));
				document.blocks.unshift({ text: "Working state: EXACT_NEEDLE_738" });
				const receipt = await capability.stage(JSON.stringify(document), toolCallId);
				// A concurrent rewrite of the read snapshot: the turn boundary discards the staged draft.
				if (options.invalidateDraft) old.timestamp += 1;
				return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
			},
		},
	];
	const mock = createMockModel({
		responses: [
			{
				content: [{ type: "toolCall", id: "edit-1", name: "rewrite_context", arguments: {} }],
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
		...options.settings,
	} as never);
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: mock.stream,
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [old, kept] },
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
	const receipts: ClmReceipt[] = [];
	session.subscribeClmActivity(activity => {
		if (activity.type === "receipt") receipts.push(activity.receipt);
	});
	await session.prompt("CURRENT_USER_REQUIREMENT: retain EXACT_NEEDLE_738");
	await session.waitForIdle();
	return { session, manager, old, kept, receipts };
}

/** The transcript a reload renders for `manager`, as plain text. */
function renderTranscript(manager: SessionManager, settings?: Settings): string {
	const ctx = createInteractiveModeContext({
		sessionManager: manager,
		settings,
		session: { buildTranscriptSessionContext: () => manager.buildSessionContext({ transcript: true }) },
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	helpers.renderSessionContext(manager.buildSessionContext({ transcript: true }));
	const text = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
	ctx.chatContainer.disposeChildren();
	return text;
}

describe("CLM transcript history", () => {
	it("attributes a deleted message to the committing revision, keeps it attributed after reload, and un-dims it on restore", async () => {
		const { session, manager, old, kept } = await editedSession();
		const edit = manager.getLatestContextProjection();
		expect(edit?.cause).toBe("edit");

		const history = resolveClmHistory(manager.getBranch());
		expect(history?.removedBy(old)?.id).toBe(edit!.id);
		expect(history?.removedBy(kept)).toBeUndefined();
		const change = history?.change(edit!.id);
		expect(change?.removed).toEqual([old]);
		expect(change?.notes.map(note => note.content)).toEqual(["Working state: EXACT_NEEDLE_738"]);

		await manager.flush();
		const reloaded = await SessionManager.open(manager.getSessionFile()!);
		const reloadedOld = reloaded
			.getBranch()
			.flatMap(entry => (entry.type === "message" ? [entry.message] : []))
			.find(message => message.role === "user" && message.content === "DISCARD_OLD_NOISE");
		expect(resolveClmHistory(reloaded.getBranch())?.removedBy(reloadedOld!)?.id).toBe(edit!.id);

		await session.restoreClmContext("previous");
		const restored = resolveClmHistory(manager.getBranch());
		expect(manager.getLatestContextProjection()?.cause).toBe("restore");
		expect(restored?.removedBy(old)).toBeUndefined();
		expect(restored?.removedBy(kept)).toBeUndefined();
	});

	it("reports one staged and one committed receipt with the draft's removal and note counts", async () => {
		const { manager, receipts } = await editedSession();
		const edit = manager.getLatestContextProjection()!;
		const staged = receipts.filter(receipt => receipt.kind === "staged");
		const committed = receipts.filter(receipt => receipt.kind === "committed");
		expect(staged).toHaveLength(1);
		expect(staged[0]).toMatchObject({ transactionId: "edit-1", removed: 1, notes: 1 });
		expect(committed).toHaveLength(1);
		expect(committed[0]).toMatchObject({
			revision: edit.id,
			cause: "edit",
			tokensBefore: edit.tokensBefore,
			tokensAfter: edit.tokensAfter,
		});
		expect(receipts.findIndex(receipt => receipt.kind === "staged")).toBeLessThan(
			receipts.findIndex(receipt => receipt.kind === "committed"),
		);
	});

	it("reports a stale write as rejected without committing", async () => {
		const { session, manager, receipts } = await editedSession();
		const revision = manager.getLatestContextProjection()!.id;
		const before = receipts.length;
		const stale = (await session.getClmContext().read({ kind: "document" })).text.replace(
			/"snapshotId":"[^"]+"/,
			'"snapshotId":"stale"',
		);
		await expect(session.getClmContext().stage(stale, "stale-writer")).rejects.toThrow();
		const added = receipts.slice(before);
		expect(added.map(receipt => receipt.kind)).toEqual(["rejected"]);
		expect(added[0]).toMatchObject({ transactionId: "stale-writer" });
		expect(manager.getLatestContextProjection()!.id).toBe(revision);
	});

	it("replays pressure chips and a rejected edit receipt after reload, honoring edit cards off", async () => {
		const { manager } = await editedSession({
			invalidateDraft: true,
			settings: { "compaction.thresholdTokens": 100 },
		});
		expect(manager.getLatestContextProjection()).toBeUndefined();
		await manager.flush();
		const reloaded = await SessionManager.open(manager.getSessionFile()!);

		const cards = renderTranscript(reloaded);
		expect(cards).toContain("clm pressure");
		expect(cards).toContain("clm urgent");
		expect(cards).toMatch(/Context edit.*rejected.*edit-1/);
		expect(cards).toContain("Stale CLM snapshot");

		const off = renderTranscript(reloaded, Settings.isolated({ "compaction.clmShowContextEdits": "off" }));
		expect(off).toContain("clm pressure");
		expect(off).not.toContain("Context edit");
		expect(off).toContain("Warning: clm: CLM rejected edit-1: Stale CLM snapshot");
	});
});
