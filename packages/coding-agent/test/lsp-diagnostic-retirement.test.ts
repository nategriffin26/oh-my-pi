import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import {
	DiagnosticLifecycle,
	buildLateDiagnosticsBatchMessage,
	retireDiagnosticMessages,
} from "../src/lsp/diagnostic-state";
import { ClmContext } from "../src/session/clm-context";
import { isClmProtectedControl } from "../src/session/clm-state";
import { SessionManager } from "../src/session/session-manager";
import type { DeferredDiagnosticsEntry } from "../src/tools";

function report(
	lifecycle: DiagnosticLifecycle,
	path: string,
	messages: string[],
	mutate = true,
): DeferredDiagnosticsEntry | undefined {
	const mutationVersion = mutate ? lifecycle.mutate(path) : lifecycle.version(path);
	return lifecycle.report({
		path,
		mutationVersion,
		summary: messages.length ? "1 warning" : "No diagnostics",
		messages,
		errored: false,
		isStale: () => lifecycle.version(path) !== mutationVersion,
	});
}
function notice(...entries: Array<DeferredDiagnosticsEntry | undefined>) {
	return buildLateDiagnosticsBatchMessage(entries.filter((entry): entry is DeferredDiagnosticsEntry => !!entry))!;
}
function host(manager: SessionManager, initial: AgentMessage[]) {
	let messages = initial;
	const clm = new ClmContext({
		manager,
		enabled: () => true,
		epoch: () => "test",
		isDisposed: () => false,
		isStreaming: () => false,
		model: () => undefined,
		messages: () => messages,
		estimate: value => JSON.stringify(value).length,
		assertFits: () => {},
		persistTurn: async () => true,
		publish: (candidate, active) => {
			messages = candidate;
			if (active) active.splice(0, active.length, ...candidate);
		},
		notice: () => {},
	});
	return { clm, messages: () => messages };
}

describe("host-owned diagnostic retirement", () => {
	it.each([false, true])(
		"retires the active provider request without owning queued input early (abort=%s)",
		async abortBeforeDispatch => {
			using dir = TempDir.createSync("@diagnostic-provider-boundary-");
			const auth = await AuthStorage.create(":memory:");
			auth.keys.setRuntime("mock", "test-key");
			const manager = SessionManager.create(dir.path(), dir.path());
			const lifecycle = new DiagnosticLifecycle(manager);
			const batch = notice(
				report(lifecycle, "/a.ts", ["PROVIDER_STALE"]),
				report(lifecycle, "/b.ts", ["PROVIDER_CURRENT"]),
			);
			const messages = [
				batch,
				{ role: "developer", content: "PROVIDER_CONTROL", timestamp: 1 },
			] satisfies AgentMessage[];
			for (const message of messages) manager.appendMessage(message);
			lifecycle.mutate("/a.ts");
			const mock = createMockModel({ responses: [{ content: ["DONE"] }] });
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
				initialState: { model: mock, systemPrompt: ["Test"], messages },
			});
			const session = new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry: new ModelRegistry(auth),
				toolRegistry: new Map(),
			});
			let checkpointBeforeDispatch = "";
			let ownedBeforeDispatch = "";
			let requestBeforeDispatch = "";
			agent.addBeforeModelCallHook((_signal, active) => {
				checkpointBeforeDispatch = JSON.stringify(manager.getLatestContextProjection()?.messages);
				ownedBeforeDispatch = JSON.stringify(session.messages);
				requestBeforeDispatch = JSON.stringify(active);
				if (abortBeforeDispatch) agent.abort();
			});
			try {
				await session.prompt("Continue");
				await session.waitForIdle();
				expect(mock.calls).toHaveLength(abortBeforeDispatch ? 0 : 1);
				expect(checkpointBeforeDispatch).not.toContain("Continue");
				expect(ownedBeforeDispatch).not.toContain("Continue");
				expect(requestBeforeDispatch).toContain("Continue");
				const request = abortBeforeDispatch
					? requestBeforeDispatch
					: JSON.stringify(mock.calls[0].context.messages);
				expect(request).not.toContain("PROVIDER_STALE");
				expect(request).toContain("PROVIDER_CURRENT");
				expect(request).toContain("PROVIDER_CONTROL");
				expect(manager.getLatestContextProjection()?.cause).toBe("diagnostics");
				const countPrompt = (messages: AgentMessage[]) =>
					messages.filter(
						message =>
							message.role === "user" &&
							(typeof message.content === "string"
								? message.content
								: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("")) ===
								"Continue",
					).length;
				expect(countPrompt(session.messages)).toBe(1);
				await manager.flush();
				expect(countPrompt(manager.buildSessionContext().messages)).toBe(1);
			} finally {
				await session.dispose();
				auth.close();
			}
		},
	);

	it("replaces superseded per-file observations without weakening current or unrelated controls", () => {
		const manager = SessionManager.inMemory();
		const lifecycle = new DiagnosticLifecycle(manager);
		const batch = notice(
			report(lifecycle, "/a.ts", ["A_OLD_UNUSED"]),
			report(lifecycle, "/b.ts", ["B_CURRENT_UNUSED"]),
		);
		const legacy = { ...batch, details: undefined, content: "LEGACY_CONTROL" };
		const altered = { ...batch, content: "DEVELOPER_OVERRIDE" };
		const developer: AgentMessage = { role: "developer", content: "IMMUTABLE", timestamp: 1 };
		const current = notice(report(lifecycle, "/a.ts", ["A_NEW_TYPE_ERROR"]));
		const messages = retireDiagnosticMessages([batch, legacy, altered, developer, current], manager.getBranch());
		expect(JSON.stringify(messages[0])).not.toContain("A_OLD_UNUSED");
		expect(JSON.stringify(messages[0])).toContain("B_CURRENT_UNUSED");
		expect(messages.slice(1)).toEqual([legacy, altered, developer, current]);
		expect(messages.every(isClmProtectedControl)).toBe(true);
		expect(retireDiagnosticMessages(messages, manager.getBranch())).toBe(messages);
	});

	it("invalidates on mutation, preserves repeated current reports, and withdraws queued reports on clean results", () => {
		const manager = SessionManager.inMemory();
		const lifecycle = new DiagnosticLifecycle(manager);
		const first = report(lifecycle, "/a.ts", ["STILL_UNUSED"])!;
		const firstMessage = notice(first);
		lifecycle.mutate("/a.ts");
		expect(first.isStale()).toBe(true);
		expect(retireDiagnosticMessages([firstMessage], manager.getBranch())).toEqual([]);
		const repeated = lifecycle.report({
			path: "/a.ts",
			mutationVersion: lifecycle.version("/a.ts"),
			summary: "",
			messages: [],
			errored: false,
			snapshot: { summary: "1 warning", messages: ["STILL_UNUSED"], errored: false },
			isStale: () => false,
		})!;
		expect(notice(repeated).content).toContain("STILL_UNUSED");
		expect(report(lifecycle, "/a.ts", ["STILL_UNUSED"], false)).toBeUndefined();
		expect(repeated.isStale()).toBe(false);
		expect(report(lifecycle, "/a.ts", [], false)).toBeUndefined();
		expect(repeated.isStale()).toBe(true);
		expect(retireDiagnosticMessages([notice(repeated)], manager.getBranch())).toEqual([]);
		expect(lifecycle.report(first)).toBeUndefined();
	});

	it("fails closed for forged, legacy and future provenance", () => {
		const manager = SessionManager.inMemory();
		const lifecycle = new DiagnosticLifecycle(manager);
		const original = notice(report(lifecycle, "/a.ts", ["CURRENT"]));
		const forged = {
			...original,
			details: { version: 1, files: [{ ...original.details!.files[0], observationId: "not-host-owned" }] },
		};
		const future = { ...original, details: { ...original.details, version: 2 } };
		const legacy = notice({
			path: "/a.ts",
			summary: "warning",
			messages: ["LEGACY"],
			errored: false,
			isStale: () => false,
		});
		lifecycle.mutate("/a.ts");
		const messages = [forged, future, legacy];
		expect(retireDiagnosticMessages(messages, manager.getBranch())).toBe(messages);
		expect(messages.every(isClmProtectedControl)).toBe(true);
	});

	it("persists retirement before publication, never restores expired observations, and retains forensic rows through resume/fork", async () => {
		using dir = TempDir.createSync("@diagnostic-retirement-");
		const manager = SessionManager.create(dir.path(), dir.path());
		const lifecycle = new DiagnosticLifecycle(manager);
		const old = notice(report(lifecycle, "/a.ts", ["RETIRED_UNUSED"]));
		const current = notice(report(lifecycle, "/b.ts", ["RETAINED_UNUSED"]));
		const messages = [
			old,
			current,
			{ role: "user", content: "Repair files", timestamp: Date.now() },
		] satisfies AgentMessage[];
		for (const message of messages) manager.appendMessage(message);
		await manager.ensureOnDisk();
		const state = host(manager, messages);
		await state.clm.commitExternal(messages, "rebase", messages);
		const oldRevision = manager.getLatestContextProjection()!.id;
		lifecycle.mutate("/a.ts");
		await state.clm.retireDiagnostics(state.messages());
		const retiredRevision = manager.getLatestContextProjection()!.id;
		expect(manager.getLatestContextProjection()?.cause).toBe("diagnostics");
		expect(JSON.stringify(state.messages())).not.toContain("RETIRED_UNUSED");
		expect(JSON.stringify(state.messages())).toContain("RETAINED_UNUSED");
		await state.clm.retireDiagnostics(state.messages());
		expect(manager.getLatestContextProjection()?.id).toBe(retiredRevision);
		await state.clm.restore(oldRevision);
		expect(JSON.stringify(state.messages())).not.toContain("RETIRED_UNUSED");
		const file = manager.getSessionFile()!;
		await manager.close();
		const resumed = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		expect(JSON.stringify(resumed.buildSessionContext().messages)).not.toContain("RETIRED_UNUSED");
		expect(JSON.stringify(resumed.buildSessionContext({ transcript: true }).messages)).toContain("RETIRED_UNUSED");
		const fork = await resumed.fork();
		expect(fork).toBeDefined();
		await resumed.close();
		const forked = await SessionManager.open(fork!.newSessionFile, dir.path(), undefined, {
			suppressBreadcrumb: true,
		});
		expect(JSON.stringify(forked.buildSessionContext().messages)).not.toContain("RETIRED_UNUSED");
		expect(JSON.stringify(forked.buildSessionContext().messages)).toContain("RETAINED_UNUSED");
		await forked.close();
	});

	it("does not resurrect expired observations when navigating or forking a historical leaf", async () => {
		using dir = TempDir.createSync("@diagnostic-historical-fork-");
		const manager = SessionManager.create(dir.path(), dir.path());
		const lifecycle = new DiagnosticLifecycle(manager);
		const batch = notice(
			report(lifecycle, "/a.ts", ["HISTORICAL_STALE"]),
			report(lifecycle, "/b.ts", ["HISTORICAL_CURRENT"]),
		);
		const oldLeaf = manager.appendMessage(batch);
		lifecycle.mutate("/a.ts");
		await manager.ensureOnDisk();
		manager.branch(oldLeaf);
		expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("HISTORICAL_STALE");
		expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("HISTORICAL_CURRENT");
		const forkFile = manager.createBranchedSession(oldLeaf);
		await manager.close();
		const fork = await SessionManager.open(forkFile!, dir.path(), undefined, { suppressBreadcrumb: true });
		expect(JSON.stringify(fork.buildSessionContext().messages)).not.toContain("HISTORICAL_STALE");
		expect(JSON.stringify(fork.buildSessionContext().messages)).toContain("HISTORICAL_CURRENT");
		await fork.close();
	});

	it("replays a durable invalidation even if the process stops before its projection boundary", async () => {
		using dir = TempDir.createSync("@diagnostic-invalidation-");
		const manager = SessionManager.create(dir.path(), dir.path());
		const lifecycle = new DiagnosticLifecycle(manager);
		manager.appendMessage(notice(report(lifecycle, "/a.ts", ["CRASH_STALE"])));
		lifecycle.mutate("/a.ts");
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await manager.close();
		const resumed = await SessionManager.open(file, dir.path(), undefined, { suppressBreadcrumb: true });
		expect(JSON.stringify(resumed.buildSessionContext().messages)).not.toContain("CRASH_STALE");
		expect(JSON.stringify(resumed.buildSessionContext({ transcript: true }).messages)).toContain("CRASH_STALE");
		const forkFile = resumed.createBranchedSession(resumed.getLeafId()!);
		const fork = await SessionManager.open(forkFile!, dir.path(), undefined, { suppressBreadcrumb: true });
		expect(JSON.stringify(fork.buildSessionContext().messages)).not.toContain("CRASH_STALE");
		await fork.close();
		await resumed.close();
	});

	it("keeps non-CLM sessions legacy until opt-in, then honors managed invalidations after opt-out", async () => {
		const manager = SessionManager.inMemory();
		let enabled = false;
		const lifecycle = new DiagnosticLifecycle(manager, () => enabled);
		const legacy = notice(report(lifecycle, "/a.ts", ["LEGACY_RETAINED"]));
		lifecycle.mutate("/a.ts");
		expect(retireDiagnosticMessages([legacy], manager.getBranch())).toEqual([legacy]);
		expect(manager.getEntries()).toEqual([]);
		enabled = true;
		const managed = notice(report(lifecycle, "/a.ts", ["MANAGED_RETIRED"]));
		enabled = false;
		lifecycle.mutate("/a.ts");
		expect(retireDiagnosticMessages([legacy, managed], manager.getBranch())).toEqual([legacy]);
	});

	it("holds concurrent boundary callers until persistence and retains messages appended during the wait", async () => {
		const manager = SessionManager.inMemory();
		const lifecycle = new DiagnosticLifecycle(manager);
		const old = notice(report(lifecycle, "/a.ts", ["WAIT_STALE"]));
		const messages: AgentMessage[] = [old];
		const appended: AgentMessage = { role: "user", content: "DURING_PERSISTENCE", timestamp: 2 };
		const queued: AgentMessage = { role: "user", content: "STILL_QUEUED", timestamp: 3 };
		const request = [...messages, appended, queued];
		manager.appendMessage(old);
		lifecycle.mutate("/a.ts");
		const persistence = Promise.withResolvers<boolean>();
		let published = false;
		const clm = new ClmContext({
			manager,
			enabled: () => true,
			epoch: () => "test",
			isDisposed: () => false,
			isStreaming: () => false,
			model: () => undefined,
			messages: () => messages,
			estimate: value => JSON.stringify(value).length,
			assertFits: () => {},
			persistTurn: () => persistence.promise,
			notice: () => {},
			publish: (candidate, active, pending) => {
				published = true;
				messages.splice(0, messages.length, ...candidate);
				if (active && active !== messages) active.splice(0, active.length, ...candidate, ...(pending ?? []));
			},
		});
		const first = clm.retireDiagnostics(messages, undefined, undefined, request);
		let secondFinished = false;
		const second = clm.retireDiagnostics(messages, undefined, undefined, request).then(() => {
			secondFinished = true;
		});
		await Promise.resolve();
		expect(published).toBe(false);
		expect(secondFinished).toBe(false);
		manager.appendMessage(appended);
		messages.push(appended);
		persistence.resolve(true);
		await Promise.all([first, second]);
		expect(messages).toContainEqual(appended);
		expect(messages).not.toContainEqual(old);
		expect(messages).not.toContainEqual(queued);
		expect(request.filter(message => message === appended)).toHaveLength(1);
		expect(request.filter(message => message === queued)).toHaveLength(1);
		expect(manager.buildSessionContext().messages).not.toContainEqual(queued);
		expect(manager.getEntries().filter(entry => entry.type === "context_projection")).toHaveLength(1);
	});

	it("commits a pending model edit with host retirement instead of invalidating or resurrecting the draft", async () => {
		const manager = SessionManager.inMemory();
		const lifecycle = new DiagnosticLifecycle(manager);
		const old = notice(report(lifecycle, "/a.ts", ["DRAFT_STALE"]));
		const messages = [
			{ role: "user", content: "OLD_HISTORY", timestamp: 1 },
			old,
			{ role: "user", content: "CURRENT_REQUEST", timestamp: 2 },
		] satisfies AgentMessage[];
		for (const message of messages) manager.appendMessage(message);
		const state = host(manager, messages);
		const document = JSON.parse(await state.clm.read({ kind: "document" }));
		document.blocks = document.blocks.filter((block: { protected?: boolean }) => block.protected);
		await state.clm.stage(JSON.stringify(document), "pending-retirement");
		lifecycle.mutate("/a.ts");
		await state.clm.retireDiagnostics(messages);
		expect(state.messages()).toContain(old);
		await state.clm.commitBoundary(messages);
		expect(manager.getLatestContextProjection()?.cause).toBe("edit");
		expect(JSON.stringify(state.messages())).not.toContain("DRAFT_STALE");
		expect(JSON.stringify(state.messages())).not.toContain("OLD_HISTORY");
		expect(JSON.stringify(state.messages())).toContain("CURRENT_REQUEST");
	});
});
