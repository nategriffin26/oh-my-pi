import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge, JudgmentRequest, Message, Questions, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildClmArchive, type ClmArchive, type ClmArchiveItem } from "../src/session/clm-archive";
import { searchClmArchive } from "../src/session/clm-archive-search";
import { createClmNoteMessage } from "../src/session/clm-state";
import { SessionManager } from "../src/session/session-manager";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(timestamp: number, ...calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
	const message: AssistantMessage = {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "archive",
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp,
		usage,
		content: calls.map(call => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args })),
	};
	return message;
}

function result(timestamp: number, id: string, name: string, text: string, isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp };
}

const temps: TempDir[] = [];
afterEach(() => {
	for (const temp of temps.splice(0)) temp.removeSync();
});

/** A session that read, edited, re-read, and ran parallel tools; returns the manager and its messages. */
function session() {
	const temp = TempDir.createSync("omp-clm-archive-");
	temps.push(temp);
	const manager = SessionManager.create(temp.path(), temp.path());
	const messages: Message[] = [
		{ role: "user", content: "Fix the parser; REQUIREMENT_NEEDLE must hold", timestamp: 1_000 },
		assistant(2_000, { id: "c1", name: "read", args: { path: "src/a.ts:1-40" } }),
		result(2_100, "c1", "read", "export const parseHeader = 1;\nlegacy ZEBRA_TOKEN = 42"),
		assistant(3_000, { id: "c2", name: "edit", args: { input: "[src/a.ts#ABCD]\nPUT 1.=1:\n+x" } }),
		result(3_100, "c2", "edit", "applied"),
		assistant(4_000, { id: "c3", name: "read", args: { path: "src/b.ts" } }),
		result(4_100, "c3", "read", "beta body"),
		assistant(5_000, { id: "c4", name: "write", args: { path: "src/b.ts", content: "nope" } }),
		result(5_100, "c4", "write", "permission denied", true),
		// Parallel calls whose results arrive in reverse order.
		assistant(
			6_000,
			{ id: "c5", name: "read", args: { path: "src/b.ts" } },
			{ id: "c6", name: "bash", args: { command: "bun test parser" } },
		),
		result(6_100, "c6", "bash", "3 pass"),
		result(6_200, "c5", "read", "beta body"),
		{ role: "user", content: "Now tighten the tokenizer", timestamp: 7_000 },
	];
	for (const message of messages) manager.appendMessage(message);
	return { manager, messages, temp };
}

function byLabel(archive: ClmArchive, label: string): ClmArchiveItem {
	const item = archive.items.find(candidate => candidate.label === label);
	if (!item) throw new Error(`no item labelled ${label}: ${archive.items.map(entry => entry.label).join(" | ")}`);
	return item;
}

/** Delete everything but the last user turn and add a note, as a CLM edit commits it. */
function deleteHistory(manager: SessionManager, messages: AgentMessage[], note: string): AgentMessage[] {
	const projected = [createClmNoteMessage(note, 7_500), messages.at(-1)!];
	manager.appendContextProjection({
		coveredThroughEntryId: manager.getLeafId(),
		messages: projected,
		rewriteAt: 7_500,
		tokensBefore: 100,
		tokensAfter: 10,
		cause: "edit",
	});
	return projected;
}

function stubJudge(probabilities: (passage: string) => number): Judge & { requests: JudgmentRequest[] } {
	const requests: JudgmentRequest[] = [];
	return {
		label: "stub",
		requests,
		async judge<Q extends Questions>(request: JudgmentRequest<Q>) {
			requests.push(request);
			const state = request.state as { passages: Record<string, string> };
			const answers = Object.fromEntries(
				Object.keys(request.questions).map(id => [id, { type: "noul", noul: probabilities(state.passages[id]) }]),
			);
			return { api: "stub", provider: "stub", model: "stub", answers, usage } as never;
		},
	};
}

describe("CLM archive", () => {
	it("keeps ids for content a CLM edit deleted, across the edit and a reload", async () => {
		const { manager, messages } = session();
		const before = buildClmArchive(manager, { live: messages });
		const zebra = byLabel(before, "read src/a.ts:1-40");
		expect(zebra.inContext).toBe(true);

		const live = deleteHistory(manager, messages, "Parser done; constraints in h-ids above");
		const after = buildClmArchive(manager, { live });
		expect(after.items.map(item => item.id)).toEqual(expect.arrayContaining(before.items.map(item => item.id)));
		expect(after.get(zebra.id)).toMatchObject({ text: zebra.text, inContext: false });
		const note = after.items.find(item => item.kind === "note");
		expect(note).toMatchObject({ inContext: true, text: "Parser done; constraints in h-ids above", turn: 2 });

		await manager.flush();
		const reopened = await SessionManager.open(manager.getSessionFile()!, path.dirname(manager.getSessionFile()!));
		const reloaded = buildClmArchive(reopened);
		expect(reloaded.items.map(item => [item.id, item.inContext])).toEqual(
			after.items.map(item => [item.id, item.inContext]),
		);
		await reopened.close();
		await manager.close();
	});

	it("pairs each call with its own result, dedups identical content, and marks stale reads", () => {
		const { manager, messages } = session();
		const archive = buildClmArchive(manager, { live: messages });

		const bash = byLabel(archive, "bash bun test parser");
		expect(bash.text).toBe('bash({"command":"bun test parser"})\n[toolResult bash]\n3 pass');
		const betaRead = byLabel(archive, "read src/b.ts");
		expect(betaRead).toMatchObject({ occurrences: 2, timestamp: 4_100, lastSeen: 6_200, turn: 1 });
		expect(archive.items.filter(item => item.label === "read src/b.ts")).toHaveLength(1);
		expect(archive.idsFor(messages.slice(9, 12))).toEqual([bash.id, betaRead.id]);

		const edit = byLabel(archive, "edit src/a.ts");
		expect(byLabel(archive, "read src/a.ts:1-40").supersededBy).toBe(edit.id);
		expect(edit.supersededBy).toBeUndefined();
		// A failed write changed nothing, so the reads of that file stay current.
		expect(betaRead.supersededBy).toBeUndefined();
		expect(archive.items.filter(item => item.kind === "user").map(item => item.turn)).toEqual([1, 2]);
	});

	it("scopes the archive to the active branch after the last reset", () => {
		const { manager } = session();
		manager.appendResetBoundary();
		const fresh = { role: "user" as const, content: "fresh start", timestamp: 9_000 };
		manager.appendMessage(fresh);
		const archive = buildClmArchive(manager, { live: [fresh] });
		expect(archive.items.map(item => item.label)).toEqual(["fresh start"]);
	});

	it("gives a persistence-truncated journal copy the id of its full original and prefers the full text", async () => {
		const temp = TempDir.createSync("omp-clm-archive-trunc-");
		temps.push(temp);
		const manager = SessionManager.create(temp.path(), temp.path());
		const huge = `HEAD_NEEDLE ${"x".repeat(600_000)} TAIL_NEEDLE`;
		const messages: Message[] = [
			{ role: "user", content: "dump it", timestamp: 1 },
			assistant(2, { id: "big", name: "bash", args: { command: "cat big.log" } }),
			result(3, "big", "bash", huge),
		];
		for (const message of messages) manager.appendMessage(message);
		await manager.flush();
		const reopened = await SessionManager.open(manager.getSessionFile()!, temp.path());
		const journalOnly = byLabel(buildClmArchive(reopened, { live: [] }), "bash cat big.log");
		expect(journalOnly.truncated).toBe(true);
		expect(journalOnly.text).not.toContain("TAIL_NEEDLE");
		const withLive = byLabel(buildClmArchive(reopened, { live: messages }), "bash cat big.log");
		expect(withLive.id).toBe(journalOnly.id);
		expect(withLive.truncated).toBeUndefined();
		expect(withLive.text).toContain("TAIL_NEEDLE");
		await reopened.close();
		await manager.close();
	});
});

describe("CLM archive search", () => {
	async function deletedArchive() {
		const { manager, messages } = session();
		const live = deleteHistory(manager, messages, "Parser fixed");
		return buildClmArchive(manager, { live });
	}

	it("finds content the model deleted by a sub-identifier and by regex", async () => {
		const archive = await deletedArchive();
		const zebra = byLabel(archive, "read src/a.ts:1-40");
		const lexical = (await searchClmArchive(archive, { query: "zebra", rerank: false })).text;
		expect(lexical).toContain(`${zebra.id} `);
		expect(lexical).toContain("L4: legacy ZEBRA_TOKEN = 42");
		expect(lexical).toContain("rerank disabled by request");

		const regex = (await searchClmArchive(archive, { query: "ZEB+RA_T.KEN\\s=\\s4", regex: true })).text;
		expect(regex).toContain("1 matching items");
		expect(regex).toContain(zebra.id);
		expect(regex.split("\n").filter(line => /^h[0-9a-f]{10} /.test(line))).toHaveLength(1);
		await expect(searchClmArchive(archive, { query: "(", regex: true })).rejects.toThrow(/Invalid archive regex/);
	});

	it("lets the judge override lexical order and drops what it judges irrelevant", async () => {
		const archive = await deletedArchive();
		// "parser" ranks the bash run and the requirement lexically; the judge wants only the requirement.
		const judge = stubJudge(passage => (passage.includes("REQUIREMENT_NEEDLE") ? 0.9 : 0.05));
		const output = (await searchClmArchive(archive, { query: "parser", judge, limit: 1 })).text;
		const requirement = archive.items.find(item => item.text.includes("REQUIREMENT_NEEDLE"))!;
		const hits = output.split("\n").filter(line => /^h[0-9a-f]{10} /.test(line));
		expect(hits).toHaveLength(1);
		expect(hits[0]).toStartWith(requirement.id);
		expect(hits[0]).toContain("relevance p=0.90");
		// One shortlist rerank request plus one label-scan request over the remaining items.
		expect(output).toContain("Jev rerank (2 requests");
		const lexicalTop = (await searchClmArchive(archive, { query: "parser", rerank: false, limit: 1 })).text
			.split("\n")
			.find(line => /^h[0-9a-f]{10} /.test(line));
		expect(lexicalTop?.startsWith(requirement.id)).toBe(false);
		expect(Object.keys(judge.requests[0].questions)).toEqual(
			expect.arrayContaining([requirement.id, byLabel(archive, "bash bun test parser").id]),
		);
	});

	it("fails open to lexical order when the judge errors", async () => {
		const archive = await deletedArchive();
		const judge: Judge = {
			label: "broken",
			async judge() {
				throw new Error("max_tokens_exceeded");
			},
		};
		const output = (await searchClmArchive(archive, { query: "zebra", judge })).text;
		expect(output).toContain("Jev rerank failed open: max_tokens_exceeded");
		expect(output).toContain(byLabel(archive, "read src/a.ts:1-40").id);
		const unavailable = (await searchClmArchive(archive, { query: "zebra", judgeUnavailable: "no TypeSafe key" }))
			.text;
		expect(unavailable).toContain("no rerank: no TypeSafe key");
	});
});
