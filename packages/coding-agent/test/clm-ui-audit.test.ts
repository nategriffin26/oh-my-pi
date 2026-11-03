import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { ClmContext } from "@oh-my-pi/pi-coding-agent/session/clm-context";
import { resolveClmHistory } from "@oh-my-pi/pi-coding-agent/session/clm-history";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ContextProjectionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ClmContextEditComponent } from "@oh-my-pi/pi-tui/chat/clm-context-edit";
import { ClmNoteMessageComponent } from "@oh-my-pi/pi-tui/chat/clm-note-message";
import { ClmRewrittenHistoryComponent } from "@oh-my-pi/pi-tui/chat/clm-rewritten-history";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme();
});
const chats: Array<{ disposeChildren(): void }> = [];
afterEach(() => {
	for (const chat of chats.splice(0)) chat.disposeChildren();
});

function projection(
	manager: SessionManager,
	messages: AgentMessage[],
	cause: ContextProjectionEntry["cause"] = "edit",
) {
	return manager.appendContextProjection({
		previousRevisionId: manager.getLatestContextProjection()?.id,
		coveredThroughEntryId: manager.getLeafId(),
		messages,
		rewriteAt: Date.now(),
		tokensBefore: 100,
		tokensAfter: 50,
		cause,
	});
}

function contextFixture(manager: SessionManager) {
	let messages = manager.buildSessionContext().messages;
	const tokenizer = new Tokenizer();
	const model = { contextWindow: 200_000 } as never;
	const clm = new ClmContext({
		manager,
		enabled: () => true,
		epoch: () => "audit",
		isDisposed: () => false,
		isStreaming: () => false,
		model: () => model,
		messages: () => messages,
		tokenizer: () => tokenizer,
		estimate: candidate => tokenizer.countTokens(JSON.stringify(candidate)),
		assertFits: () => {},
		persistTurn: async () => true,
		publish: candidate => {
			messages = candidate;
		},
		notice: () => {},
	});
	return { clm, messages: () => messages };
}

function renderFixture(manager: SessionManager, clm = contextFixture(manager).clm) {
	const ctx = createInteractiveModeContext({
		sessionManager: manager,
		session: {
			buildTranscriptSessionContext: () => manager.buildSessionContext({ transcript: true }),
			getClmContext: () => clm,
		},
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	chats.push(ctx.chatContainer);
	return {
		ctx,
		helpers,
		paint: () => helpers.renderSessionContext(manager.buildSessionContext({ transcript: true })),
	};
}

describe("CLM adversarial transcript contracts", () => {
	it("does not reprocess a settled large tool output on unrelated CLM commits", async () => {
		const manager = SessionManager.inMemory();
		const result: AgentMessage = {
			role: "toolResult",
			toolName: "large_output",
			toolCallId: "large",
			isError: false,
			timestamp: 2,
			content: [{ type: "text", text: "payload ".repeat(131072) }],
		};
		manager.appendMessage({
			role: "assistant",
			api: "mock",
			provider: "mock",
			model: "test",
			stopReason: "toolUse",
			timestamp: 1,
			content: [{ type: "toolCall", id: "large", name: "large_output", arguments: {} }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		manager.appendMessage(result);
		let processedBytes = 0;
		const tool = {
			name: "large_output",
			renderResult: (output: { content: Array<{ type: string; text?: string }> }) => {
				processedBytes += output.content.reduce((total, block) => total + (block.text?.length ?? 0), 0);
				return new Text("LARGE_TOOL_OUTPUT_VISIBLE");
			},
		};
		const { ctx, helpers } = renderFixture(manager);
		ctx.viewSession.getToolByName = () => tool as never;
		ctx.viewSession.hasBuiltInTool = () => false;
		const controller = new EventController(ctx);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "large",
			toolName: "large_output",
			args: {},
		});
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "large",
			toolName: "large_output",
			result: { content: result.content },
			isError: false,
		});
		await controller.handleEvent({ type: "message_end", message: result });
		ctx.chatContainer.render(120);
		const initialBytes = processedBytes;
		expect(initialBytes).toBeGreaterThan(1000000);
		projection(manager, manager.buildSessionContext().messages);
		ctx.chatContainer.clear();
		helpers.renderSessionContext(manager.buildSessionContext({ transcript: true }), { reuseSettledComponents: true });
		expect(Bun.stripANSI(ctx.chatContainer.render(120).join("\n"))).toContain("LARGE_TOOL_OUTPUT_VISIBLE");
		expect(processedBytes).toBe(initialBytes);
	});

	it("dims historical note cards after a restore removes their note from provider context", () => {
		const manager = SessionManager.inMemory();
		const user: AgentMessage = { role: "user", content: "keep", timestamp: 1 };
		manager.appendMessage(user);
		const note: AgentMessage = { role: "clmNote", content: "NOTE_REMOVED_ON_RESTORE", timestamp: 2 };
		projection(manager, [note, user]);
		projection(manager, [user], "restore");
		expect(
			manager
				.buildSessionContext()
				.messages.some(message => message.role === "clmNote" && message.content === note.content),
		).toBe(false);
		const { ctx, paint } = renderFixture(manager);
		paint();
		expect(ctx.chatContainer.children.some(child => child instanceof ClmNoteMessageComponent)).toBe(false);
		expect(
			ctx.chatContainer.children.some(
				child =>
					child instanceof ClmRewrittenHistoryComponent &&
					child.children.some(nested => nested instanceof ClmNoteMessageComponent),
			),
		).toBe(true);
	});

	it("does not render queued CLM activity into a different viewed session", async () => {
		let dispatch!: (event: AgentSessionEvent) => Promise<void>;
		const ctx = createInteractiveModeContext({
			session: {
				subscribe: listener => {
					dispatch = async event => {
						await listener(event);
					};
					return () => {};
				},
				subscribeClmActivity: () => () => {},
			},
		});
		chats.push(ctx.chatContainer);
		const controller = new EventController(ctx);
		controller.subscribeToAgent();
		controller.handleClmActivity({
			type: "notice",
			notice: { kind: "pressure", tokens: 123_456, softLimitTokens: 160_000, message: "OLD_SESSION_PRESSURE" },
		});
		ctx.session = createInteractiveModeContext().session;
		controller.resetTranscriptAnchors();
		await dispatch({ type: "notice", level: "info", message: "drain dispatch" });
		ctx.unsubscribe?.();
		expect(Bun.stripANSI(ctx.chatContainer.render(120).join("\n"))).not.toContain("clm pressure");
	});

	it("records actual archive growth and keeps a historical receipt stable after new archive items arrive", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "DELETE_ONLY", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "keep", timestamp: 2 });
		const { clm, messages } = contextFixture(manager);
		const before = clm.archive().items.length;
		const document = JSON.parse((await clm.read({ kind: "document" })).text);
		document.blocks = document.blocks.filter((block: { text: string }) => !block.text.includes("DELETE_ONLY"));
		await clm.stage(JSON.stringify(document), "growth");
		await clm.commitBoundary(messages());
		const edit = manager.getLatestContextProjection()!;
		const after = clm.archive().items.length;
		expect(after - before).toBe(0);
		expect(edit).toMatchObject({ archiveGrowth: 0, archiveItems: after });
		const later: AgentMessage = { role: "user", content: "LATER_ARCHIVE_ITEM", timestamp: Date.now() + 1 };
		manager.appendMessage(later);
		messages().push(later);
		const { ctx, paint } = renderFixture(manager, clm);
		paint();
		const receipt = ctx.chatContainer.children.find(
			child => child instanceof ClmContextEditComponent,
		) as ClmContextEditComponent;
		expect(receipt.view).toMatchObject({ archiveItems: after, archiveGrowth: 0 });
		expect(Bun.stripANSI(receipt.render(120).join("\n"))).not.toContain("+1 recallable");
	});

	it("groups a long deleted run without quadratic transcript-list traversal", () => {
		const manager = SessionManager.inMemory();
		const kept = Array.from({ length: 200 }, (_, i): Message => ({
			role: "user",
			content: `kept ${i}`,
			timestamp: i + 1,
		}));
		const removed = Array.from({ length: 200 }, (_, i): Message => ({
			role: "user",
			content: `removed ${i}`,
			timestamp: i + 201,
		}));
		for (const message of [...kept, ...removed]) manager.appendMessage(message);
		projection(manager, kept);
		const { ctx, paint } = renderFixture(manager);
		let visited = 0;
		ctx.chatContainer.children = new Proxy(ctx.chatContainer.children, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) visited++;
				return Reflect.get(target, property, receiver);
			},
		});
		paint();
		expect(ctx.chatContainer.children.filter(child => child instanceof ClmRewrittenHistoryComponent)).toHaveLength(1);
		// Count indexed visits rather than timing: this catches quadratic grouping without CPU-speed flakes.
		expect(visited).toBeLessThan(20 * (kept.length + removed.length));
	});

	it("distinguishes same-millisecond human messages when only one is removed", () => {
		const manager = SessionManager.inMemory();
		const old: AgentMessage = { role: "user", content: "same ms removed", timestamp: 1 };
		const kept: AgentMessage = { role: "user", content: "same ms kept", timestamp: 1 };
		manager.appendMessage(old);
		manager.appendMessage(kept);
		const edit = projection(manager, [kept]);
		expect(
			manager
				.buildSessionContext()
				.messages.some(message => message.role === "user" && message.content === old.content),
		).toBe(false);
		const history = resolveClmHistory(manager.getBranch())!;
		expect(history.removedBy(old)?.id).toBe(edit);
		expect(history.removedBy(kept)).toBeUndefined();
	});

	it("dims a branch summary removed by a later revision, matching the provider context", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
		const first = projection(manager, manager.buildSessionContext().messages);
		manager.branchWithSummary(first, "BRANCH_SUMMARY_REMOVED");
		const before = manager.buildSessionContext().messages;
		const summary = before.find(message => message.role === "branchSummary")!;
		expect(summary).toBeDefined();
		const edit = projection(
			manager,
			before.filter(message => message !== summary),
		);
		expect(manager.buildSessionContext().messages.some(message => message.role === "branchSummary")).toBe(false);
		const history = resolveClmHistory(manager.getBranch())!;
		expect(history.change(edit)?.removed).toContainEqual(summary);
		expect(history.removedBy(summary)?.id).toBe(edit);
	});

	it("does not leave surviving history dimmed when a fast rewind removes the responsible revision", () => {
		const manager = SessionManager.inMemory();
		const old: AgentMessage = { role: "user", content: "RESTORED_HISTORY", timestamp: 1 };
		const cut: AgentMessage = { role: "user", content: "REWIND_FROM_HERE", timestamp: 2 };
		const root = manager.appendMessage(old);
		manager.appendMessage(cut);
		projection(manager, [cut]);
		const { ctx, helpers, paint } = renderFixture(manager);
		paint();
		expect(ctx.chatContainer.children.some(child => child instanceof ClmRewrittenHistoryComponent)).toBe(true);
		manager.branch(root);
		// Returning false asks the caller for the full replay that restores earlier appearance.
		if (helpers.truncateTranscriptFromMessage(cut)) {
			expect(ctx.chatContainer.children.some(child => child instanceof ClmRewrittenHistoryComponent)).toBe(false);
		} else {
			ctx.chatContainer.clear();
			paint();
		}
		const rendered = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("RESTORED_HISTORY");
		expect(rendered).not.toContain("▏");
	});
});
