import { afterEach, describe, expect, it } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, DeveloperMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { ClmContext } from "../src/session/clm-context";
import type { ClmContextAccess } from "../src/session/clm-types";
import { CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE } from "../src/session/clm-state";
import { convertToLlm } from "../src/session/messages";
import { SessionManager, SessionPersistenceIndeterminateError } from "../src/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "../src/session/session-storage";
import type { ToolSession } from "../src/tools";
import { ReadTool } from "../src/tools/read";

interface EditableDocument {
	blocks: Array<{ id?: string; text: string; protected?: boolean; opaque?: boolean }>;
}

class BoundaryStorage extends MemorySessionStorage {
	readonly started = Promise.withResolvers<void>();
	readonly release = Promise.withResolvers<void>();
	pauseNext = false;
	failuresRemaining = 0;
	publishBeforeFailure = false;

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.pauseNext) {
			this.pauseNext = false;
			this.started.resolve();
			await this.release.promise;
		}
		if (this.failuresRemaining > 0) {
			this.failuresRemaining--;
			if (this.publishBeforeFailure) {
				this.publishBeforeFailure = false;
				await super.writeTextAtomic(path, content, options);
			}
			throw new Error("injected checkpoint storage failure");
		}
		await super.writeTextAtomic(path, content, options);
	}
}

function user(content: string, timestamp: number): UserMessage {
	return { role: "user", content, timestamp };
}

function assistant(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "boundary",
		stopReason,
		timestamp: 3,
		content: [{ type: "text", text: "COMPLETED_TURN" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function harness() {
	const storage = new BoundaryStorage();
	const manager = SessionManager.create("/clm-boundary", `/clm-boundary/${Bun.randomUUIDv7()}`, storage);
	const messages = [user("DISCARD_OLD_NOISE", 1), user("CURRENT_HUMAN_CONSTRAINT", 2)];
	for (const message of messages) manager.appendMessage(message);
	await manager.ensureOnDisk();
	await manager.flush();
	const mock = createMockModel({
		responses: [{ content: ["FIRST_PROVIDER_TURN"] }, { content: ["SECOND_PROVIDER_TURN"] }],
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: mock.stream,
		initialState: { model: mock, systemPrompt: ["Test"], messages },
	});
	let model: Model = mock;
	let epoch = "initial";
	let persistTurn = async (_context: AgentTurnEndContext | undefined): Promise<boolean> => true;
	let publicationFailure: Error | undefined;
	const notices: string[] = [];
	const clm = new ClmContext({
		manager,
		enabled: () => true,
		epoch: () => epoch,
		isDisposed: () => false,
		isStreaming: () => agent.state.isStreaming,
		model: () => model,
		messages: () => agent.state.messages,
		estimate: candidate => JSON.stringify(candidate).length,
		assertFits: () => {},
		persistTurn: context => persistTurn(context),
		publish: (candidate, active) => {
			if (publicationFailure) throw publicationFailure;
			agent.replaceMessages(candidate);
			if (active) active.splice(0, active.length, ...candidate);
		},
		notice: (_level, message) => notices.push(message),
	});
	agent.setOnTurnEnd(async (active, signal, context) => {
		await clm.commitBoundary(active, signal, context);
	});
	return {
		clm,
		manager,
		storage,
		agent,
		mock,
		notices,
		setModel: (value: Model) => {
			model = value;
		},
		setEpoch: (value: string) => {
			epoch = value;
		},
		setPersistence: (value: typeof persistTurn) => {
			persistTurn = value;
		},
		failPublication: (error: Error) => {
			publicationFailure = error;
		},
		append: (message: UserMessage | DeveloperMessage | AssistantMessage, active?: AgentMessage[]) => {
			manager.appendMessage(message);
			agent.appendMessage(message);
			active?.push(message);
		},
		resume: async () =>
			SessionManager.open(manager.getSessionFile()!, undefined, storage, { suppressBreadcrumb: true }),
	};
}

async function editedDocument(clm: ClmContextAccess, note = "KEPT_WORKING_NEEDLE"): Promise<string> {
	const document = JSON.parse(await clm.read({ kind: "document" })) as EditableDocument;
	document.blocks = document.blocks.filter(block => !block.text.includes("DISCARD_OLD_NOISE"));
	document.blocks.unshift({ text: note });
	return JSON.stringify(document);
}

function text(messages: AgentMessage[]): string[] {
	const effective = messages.filter(
		message => message.role !== "custom" || message.customType !== CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE,
	);
	return convertToLlm(effective).flatMap(message =>
		typeof message.content === "string"
			? [message.content]
			: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])),
	);
}

async function staged(clm: ClmContext, transaction = "edit"): Promise<void> {
	await clm.stage(await editedDocument(clm), transaction);
}

async function assertNoDraft(clm: ClmContext): Promise<void> {
	const status = JSON.parse(await clm.read({ kind: "status" })) as { staged: string | null };
	expect(status.staged).toBeNull();
}

async function eventLoopBoundary(): Promise<void> {
	await setImmediate();
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function terminalSession(failCheckpoint = false) {
	const dir = TempDir.createSync("omp-clm-terminal-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("mock", "test-key");
	const registry = new ModelRegistry(auth);
	const storage = new BoundaryStorage();
	const manager = SessionManager.create(dir.path(), dir.path(), storage);
	const old = user("DISCARD_OLD_NOISE", 1);
	manager.appendMessage(old);
	await manager.ensureOnDisk();
	await manager.flush();
	const tools: AgentTool[] = [
		{
			name: "yield",
			label: "Yield",
			description: "Commit working context and yield",
			parameters: type({}),
			execute: async toolCallId => {
				const capability = session.getClmContext();
				await capability.stage(await editedDocument(capability), toolCallId);
				if (failCheckpoint) {
					storage.failuresRemaining = 2;
					storage.publishBeforeFailure = true;
				}
				return { content: [{ type: "text", text: "TERMINAL_YIELD_RESULT" }] };
			},
		},
	];
	const mock = createMockModel({
		responses: [
			{
				content: [{ type: "toolCall", id: "terminal-edit", name: "yield", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: ["MUST_NOT_DISPATCH"] },
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
		try {
			await session.dispose();
		} finally {
			auth.close();
			dir.removeSync();
		}
	});
	return { session, manager, storage, mock };
}

describe("CLM transaction lifecycle", () => {
	it("commits a terminal yield tool through AgentSession without treating its graceful abort as cancellation", async () => {
		const h = await terminalSession();
		await h.session.prompt("CURRENT_TERMINAL_HUMAN_CONSTRAINT");
		await h.session.waitForIdle();
		expect(h.mock.calls).toHaveLength(1);
		expect(h.manager.getLatestContextProjection()?.cause).toBe("edit");
		expect(text(h.session.messages).join("\n")).not.toContain("DISCARD_OLD_NOISE");
		expect(text(h.session.messages).join("\n")).toContain("CURRENT_TERMINAL_HUMAN_CONSTRAINT");
		await h.manager.flush();
		const resumed = await SessionManager.open(h.manager.getSessionFile()!, undefined, h.storage, {
			suppressBreadcrumb: true,
		});
		const context = text(resumed.buildSessionContext().messages);
		expect(context.join("\n")).toContain("KEPT_WORKING_NEEDLE");
		expect(context.filter(value => value === "TERMINAL_YIELD_RESULT")).toEqual(["TERMINAL_YIELD_RESULT"]);
		expect(
			h.manager
				.getBranch()
				.filter(entry => entry.type === "message" && entry.message.role === "toolResult")
				.map(entry =>
					entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolCallId : "",
				),
		).toEqual(["terminal-edit"]);
	});

	it("blocks later provider requests after a lost checkpoint acknowledgment and failed rollback, even after disk repair", async () => {
		const h = await terminalSession(true);
		await h.session.prompt("CURRENT_TERMINAL_HUMAN_CONSTRAINT");
		await h.session.waitForIdle();
		expect(h.manager.getLatestContextProjection()).toBeUndefined();
		expect(text(h.session.messages).join("\n")).toContain("DISCARD_OLD_NOISE");
		await expect(h.manager.flush()).rejects.toBeInstanceOf(SessionPersistenceIndeterminateError);
		await h.manager.recoverPersistenceFromCurrentState();
		await h.session.prompt("DO_NOT_RUN_WITH_UNCERTAIN_CONTEXT");
		await h.session.waitForIdle();
		expect(h.mock.calls).toHaveLength(1);
		await expect(h.session.getClmContext().stage("{}", "blocked")).rejects.toThrow(/publication.*indeterminate/i);
	});
	it("durably finalizes a healthy terminal yield even without a following provider call", async () => {
		const h = await harness();
		await staged(h.clm);
		await h.agent.prompt("TERMINAL_HUMAN_CONSTRAINT");
		expect(h.mock.calls).toHaveLength(1);
		expect(text(h.agent.state.messages).join("\n")).not.toContain("DISCARD_OLD_NOISE");
		const resumed = await h.resume();
		expect(text(resumed.buildSessionContext().messages).join("\n")).toContain("KEPT_WORKING_NEEDLE");
		expect(text(resumed.buildSessionContext().messages).join("\n")).toContain("TERMINAL_HUMAN_CONSTRAINT");
		await assertNoDraft(h.clm);
	});

	for (const stopReason of ["aborted", "error"] as const) {
		it(`discards a ${stopReason} turn instead of creating a revision`, async () => {
			const h = await harness();
			await staged(h.clm);
			const message = assistant(stopReason);
			const active = [...h.agent.state.messages, message];
			await h.clm.commitBoundary(active, undefined, { message, toolResults: [], willContinue: false });
			expect(h.manager.getLatestContextProjection()).toBeUndefined();
			expect(text(h.agent.state.messages).join("\n")).toContain("DISCARD_OLD_NOISE");
			await assertNoDraft(h.clm);
		});
	}

	it("discards cancellation arriving during turn persistence before any revision is appended", async () => {
		const h = await harness();
		const persistence = Promise.withResolvers<boolean>();
		h.setPersistence(() => persistence.promise);
		await staged(h.clm);
		const abort = new AbortController();
		const boundary = h.clm.commitBoundary([...h.agent.state.messages], abort.signal);
		abort.abort();
		persistence.resolve(true);
		await boundary;
		expect(h.manager.getLatestContextProjection()).toBeUndefined();
		await assertNoDraft(h.clm);
	});

	it("keeps the prior effective revision when turn outcomes were persisted out of order", async () => {
		const h = await harness();
		h.setPersistence(async () => false);
		await staged(h.clm);
		await h.clm.commitBoundary([...h.agent.state.messages]);
		expect(h.manager.getLatestContextProjection()).toBeUndefined();
		expect(text((await h.resume()).buildSessionContext().messages)).toEqual([
			"DISCARD_OLD_NOISE",
			"CURRENT_HUMAN_CONSTRAINT",
		]);
		await assertNoDraft(h.clm);
	});

	it("rolls back a failed checkpoint without exposing edited context live or after resume", async () => {
		const h = await harness();
		await staged(h.clm, "accepted");
		await h.clm.commitBoundary([...h.agent.state.messages]);
		const previous = h.manager.getLatestContextProjection()!.id;
		const before = text(h.agent.state.messages);
		await h.clm.stage(await editedDocument(h.clm, "REJECTED_CANDIDATE"), "fails");
		h.storage.failuresRemaining = 1;
		await h.clm.commitBoundary([...h.agent.state.messages]);
		expect(h.manager.getLatestContextProjection()?.id).toBe(previous);
		expect(text(h.agent.state.messages)).toEqual(before);
		expect(text((await h.resume()).buildSessionContext().messages)).toEqual(before);
		await assertNoDraft(h.clm);
	});

	it("holds repeated boundary consumers until one durable publication and commits only once", async () => {
		const h = await harness();
		const active = [...h.agent.state.messages];
		await staged(h.clm);
		h.storage.pauseNext = true;
		const first = h.clm.commitBoundary(active);
		await h.storage.started.promise;
		const repeated = h.clm.commitBoundary(active).then(() => h.agent.prompt("NEXT_PROVIDER_CONSTRAINT"));
		await eventLoopBoundary();
		const callsBeforeDurability = h.mock.calls.length;
		h.storage.release.resolve();
		await Promise.all([first, repeated]);
		expect(callsBeforeDurability).toBe(0);
		expect(JSON.stringify(h.mock.calls[0].context.messages)).not.toContain(JSON.stringify("DISCARD_OLD_NOISE"));
		await h.clm.commitBoundary(active);
		expect(h.manager.getEntries().filter(entry => entry.type === "context_projection")).toHaveLength(1);
		expect(text(active).join("\n")).not.toContain("DISCARD_OLD_NOISE");
	});

	it("preserves suffixes appended before, during, and after the serialized checkpoint exactly once", async () => {
		const h = await harness();
		const active = [...h.agent.state.messages];
		const persistence = Promise.withResolvers<boolean>();
		h.setPersistence(() => persistence.promise);
		await staged(h.clm);
		h.storage.pauseNext = true;
		const boundary = h.clm.commitBoundary(active);
		h.append(user("BEFORE_SERIALIZED_APPEND", 4), active);
		persistence.resolve(true);
		await h.storage.started.promise;
		h.append(user("DURING_DURABILITY_WAIT", 5), active);
		h.storage.release.resolve();
		await boundary;
		h.append(user("AFTER_PUBLICATION", 6), active);
		await h.manager.flush();
		const resumed = await h.resume();
		for (const marker of ["BEFORE_SERIALIZED_APPEND", "DURING_DURABILITY_WAIT", "AFTER_PUBLICATION"]) {
			for (const messages of [active, h.agent.state.messages, resumed.buildSessionContext().messages]) {
				expect(text(messages).filter(value => value === marker)).toEqual([marker]);
			}
		}
		expect(text(active).join("\n")).not.toContain("DISCARD_OLD_NOISE");
	});

	it("retains an accepted durable revision when cancellation arrives during storage publication", async () => {
		const h = await harness();
		await staged(h.clm);
		h.storage.pauseNext = true;
		const abort = new AbortController();
		const active = [...h.agent.state.messages];
		const boundary = h.clm.commitBoundary(active, abort.signal);
		await h.storage.started.promise;
		abort.abort();
		h.storage.release.resolve();
		await boundary;
		expect(text(active).join("\n")).not.toContain("DISCARD_OLD_NOISE");
		expect(text((await h.resume()).buildSessionContext().messages).join("\n")).toContain("KEPT_WORKING_NEEDLE");
	});

	it("halts the boundary instead of continuing against old state when live publication fails after durability", async () => {
		const h = await harness();
		await staged(h.clm);
		h.failPublication(new Error("consumer rebase failed"));
		const failure = await h.clm.commitBoundary([...h.agent.state.messages]).then(
			() => undefined,
			error => error,
		);
		expect(text((await h.resume()).buildSessionContext().messages).join("\n")).not.toContain("DISCARD_OLD_NOISE");
		expect(failure).toBeInstanceOf(Error);
	});

	for (const change of ["model", "epoch"] as const) {
		it(`publishes the durable revision when an interrupt or ${change} change lands during the append`, async () => {
			const h = await harness();
			await staged(h.clm);
			h.storage.pauseNext = true;
			const boundary = h.clm.commitBoundary(h.agent.state.messages);
			await h.storage.started.promise;
			// AgentSession.abort advances the prompt epoch and discards the draft mid-publication.
			if (change === "model") h.setModel(createMockModel({ responses: [] }));
			else h.setEpoch("interrupted-owner");
			h.clm.discard("session interrupted");
			h.storage.release.resolve();
			await boundary;
			expect(text(h.agent.state.messages).join("\n")).toContain("KEPT_WORKING_NEEDLE");
			expect(text(h.agent.state.messages).join("\n")).not.toContain("DISCARD_OLD_NOISE");
			expect(() => h.clm.assertHealthy()).not.toThrow();
			const resumed = await h.resume();
			expect(text(resumed.buildSessionContext().messages).join("\n")).toContain("KEPT_WORKING_NEEDLE");
		});
	}

	it("preserves live state and requires reopen when the covered prefix is rewritten after the durable append", async () => {
		const h = await harness();
		await staged(h.clm);
		h.storage.pauseNext = true;
		const boundary = h.clm.commitBoundary(h.agent.state.messages);
		await h.storage.started.promise;
		const live = h.agent.state.messages;
		live.splice(live.length - 1, 1, user("NEW_PROTECTED_TASK", 2));
		const before = text(h.agent.state.messages);
		h.storage.release.resolve();
		await expect(boundary).rejects.toThrow(/publication is indeterminate/);
		expect(text(h.agent.state.messages)).toEqual(before);
		await expect(h.clm.stage("{}", "blocked")).rejects.toThrow(/reopen/);
		const resumed = await h.resume();
		expect(text(resumed.buildSessionContext().messages).join("\n")).toContain("KEPT_WORKING_NEEDLE");
	});

	for (const change of ["model", "owner", "epoch", "reset"] as const) {
		it(`rejects a staged draft whose ${change} changed while persistence was pending`, async () => {
			const h = await harness();
			const persistence = Promise.withResolvers<boolean>();
			h.setPersistence(() => persistence.promise);
			await staged(h.clm);
			const boundary = h.clm.commitBoundary([...h.agent.state.messages]);
			if (change === "model") h.setModel(createMockModel({ responses: [] }));
			if (change === "epoch") h.setEpoch("new-owner");
			if (change === "owner") {
				const other = SessionManager.create(
					"/clm-boundary",
					`/clm-boundary/other-${Bun.randomUUIDv7()}`,
					h.storage,
				);
				other.appendMessage(user("OTHER_OWNER", 20));
				await other.ensureOnDisk();
				await other.flush();
				await h.manager.setSessionFile(other.getSessionFile()!);
			}
			if (change === "reset") h.manager.appendResetBoundary();
			persistence.resolve(true);
			await boundary;
			expect(h.manager.getLatestContextProjection()).toBeUndefined();
			await assertNoDraft(h.clm);
		});
	}

	it("rejects an older snapshot after another revision rather than resurrecting deleted history", async () => {
		const h = await harness();
		const stale = await editedDocument(h.clm);
		await h.clm.stage(await editedDocument(h.clm, "NEWER_REVISION"), "newer");
		await h.clm.commitBoundary([...h.agent.state.messages]);
		await expect(h.clm.stage(stale, "stale")).rejects.toThrow(/snapshot/i);
		expect(text(h.agent.state.messages).join("\n")).toContain("NEWER_REVISION");
		expect(text(h.agent.state.messages).join("\n")).not.toContain("KEPT_WORKING_NEEDLE");
	});

	it("restores an old revision as a successor while preserving current human and developer constraints", async () => {
		const h = await harness();
		h.append({ role: "developer", content: "ARCHIVED_DEVELOPER_CONSTRAINT", timestamp: 9 });
		await staged(h.clm, "first");
		await h.clm.commitBoundary([...h.agent.state.messages]);
		const oldRevision = h.manager.getLatestContextProjection()!.id;
		h.append({ role: "developer", content: "CURRENT_DEVELOPER_CONSTRAINT", timestamp: 10 });
		h.append(user("NEW_HUMAN_CONSTRAINT", 11));
		h.append({ role: "developer", content: "LIVE_TAIL_DEVELOPER_CONSTRAINT", timestamp: 12 });
		await h.clm.stage(await editedDocument(h.clm, "NEWER_WORKING_STATE"), "second");
		await h.clm.commitBoundary([...h.agent.state.messages]);
		const beforeRestore = h.manager.getLatestContextProjection()!.id;
		await h.clm.restore(oldRevision);
		const restored = h.manager.getLatestContextProjection()!;
		expect(restored.id).not.toBe(oldRevision);
		expect(restored.previousRevisionId).toBe(beforeRestore);
		expect(restored.cause).toBe("restore");
		const effective = text((await h.resume()).buildSessionContext().messages);
		expect(effective.filter(value => value === "CURRENT_DEVELOPER_CONSTRAINT")).toEqual([
			"CURRENT_DEVELOPER_CONSTRAINT",
		]);
		expect(effective.filter(value => value === "NEW_HUMAN_CONSTRAINT")).toEqual(["NEW_HUMAN_CONSTRAINT"]);
		expect(effective.join("\n")).not.toContain("NEWER_WORKING_STATE");
		expect(restored.messages.filter(message => message.role === "developer").map(message => message.content)).toEqual(
			["ARCHIVED_DEVELOPER_CONSTRAINT", "CURRENT_DEVELOPER_CONSTRAINT", "LIVE_TAIL_DEVELOPER_CONSTRAINT"],
		);
	});

	it("serves later pages from the earlier page's snapshot across turns and stages the stitched document", async () => {
		const h = await harness();
		const session = {
			cwd: "/clm-boundary",
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => h.manager.getSessionId(),
			sessionManager: h.manager,
			clmContext: h.clm,
		} as ToolSession;
		const page = async (selector: string) =>
			(await new ReadTool(session).execute("page", { path: `context://self:raw:${selector}` })).content
				.flatMap(block => (block.type === "text" ? [block.text] : []))
				.join("");
		const first = await page("1-2");
		h.append(user("APPENDED_NEXT_TURN", 4));
		const rest = await page("3-");
		// Page 1 ends in the read tool's continuation footer; a stitcher keeps only the selected lines.
		const document = JSON.parse(`${first.split("\n").slice(0, 2).join("\n")}\n${rest}`) as EditableDocument;
		expect(document.blocks.map(block => block.text).join("\n")).not.toContain("APPENDED_NEXT_TURN");
		document.blocks = document.blocks.filter(block => !block.text.includes("DISCARD_OLD_NOISE"));
		await h.clm.stage(JSON.stringify(document), "paged");
		await h.clm.commitBoundary(h.agent.state.messages);
		const effective = text(h.agent.state.messages).join("\n");
		expect(effective).not.toContain("DISCARD_OLD_NOISE");
		expect(effective).toContain("APPENDED_NEXT_TURN");
		await expect(page("3-")).rejects.toThrow(/current snapshot is .*from line 1/);
	});
});
