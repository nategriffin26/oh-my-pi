import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildClmArchive } from "../src/session/clm-archive";
import { createClmNoteMessage } from "../src/session/clm-state";
import { SessionManager } from "../src/session/session-manager";

const temps: TempDir[] = [];
afterEach(() => {
	for (const temp of temps.splice(0)) temp.removeSync();
});

function manager() {
	const temp = TempDir.createSync("omp-archive-adversarial-");
	temps.push(temp);
	return SessionManager.create(path.resolve(temp.path()), path.resolve(temp.path()));
}

function exchange(timestamp: number, id: string, name: string, args: Record<string, unknown>, text: string): Message[] {
	const call: AssistantMessage = {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "mock",
		timestamp,
		stopReason: "toolUse",
		content: [{ type: "toolCall", id, name, arguments: args }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		timestamp: timestamp + 1,
		isError: false,
	};
	return [call, result];
}

describe("archive chronological identities", () => {
	it("preserves identity when a large tool argument happens to use a Signature-suffixed key", async () => {
		const sm = manager();
		for (const message of exchange(1, "signed", "sign", { payload: { traceSignature: "x".repeat(600_000) } }, "ok"))
			sm.appendMessage(message);
		const original = buildClmArchive(sm);
		await sm.flush();
		const reopened = await SessionManager.open(sm.getSessionFile()!, sm.getSessionDir());
		expect(buildClmArchive(reopened).items.map(item => item.id)).toEqual(original.items.map(item => item.id));
		await reopened.close();
		await sm.close();
	});
	it("keeps a changed full projection distinct from its fingerprinted truncated predecessor", async () => {
		const sm = manager();
		const prefix = "x".repeat(600_000);
		const original = exchange(1, "shared", "bash", { command: "cat log" }, `${prefix} OLD_TAIL`);
		for (const message of original) sm.appendMessage(message);
		const oldId = buildClmArchive(sm).items[0].id;
		await sm.flush();
		const reopened = await SessionManager.open(sm.getSessionFile()!, sm.getSessionDir());
		const changed = exchange(1, "shared", "bash", { command: "cat log" }, `${prefix} NEW_TAIL`);
		reopened.appendContextProjection({
			coveredThroughEntryId: reopened.getLeafId(),
			messages: changed,
			rewriteAt: 3,
			tokensBefore: 100,
			tokensAfter: 100,
			cause: "spill",
		});
		const archive = buildClmArchive(reopened);
		expect(archive.get(oldId)?.truncated).toBe(true);
		expect(archive.get(oldId)?.text).not.toContain("NEW_TAIL");
		const newest = archive.items.find(item => item.text.endsWith("NEW_TAIL"));
		expect(newest?.id).not.toBe(oldId);
		expect(newest?.inContext).toBe(true);
		await reopened.close();
		await sm.close();
	});
	it("retains changed spill-projection output after a later rewrite removes it", async () => {
		const sm = manager();
		const original = exchange(1, "read", "read", { path: "a.ts" }, "ORIGINAL_OUTPUT");
		for (const message of original) sm.appendMessage(message);
		const spilled = exchange(1, "read", "read", { path: "a.ts" }, "Read artifact://spill to recover SPILLED_OUTPUT");
		sm.appendContextProjection({
			coveredThroughEntryId: sm.getLeafId(),
			messages: spilled,
			rewriteAt: 3,
			tokensBefore: 100,
			tokensAfter: 20,
			cause: "spill",
		});
		sm.appendContextProjection({
			coveredThroughEntryId: sm.getLeafId(),
			messages: [createClmNoteMessage("Done", 4)],
			rewriteAt: 4,
			tokensBefore: 20,
			tokensAfter: 1,
			cause: "edit",
		});
		const archive = buildClmArchive(sm);
		expect(archive.items.filter(item => item.toolName === "read").map(item => item.text)).toEqual(
			["ORIGINAL_OUTPUT", "Read artifact://spill to recover SPILLED_OUTPUT"].map(
				text => `read({"path":"a.ts"})\n[toolResult read]\n${text}`,
			),
		);
		expect(archive.items.filter(item => item.toolName === "read").map(item => item.inContext)).toEqual([
			false,
			false,
		]);
		await sm.flush();
		const reopened = await SessionManager.open(sm.getSessionFile()!, sm.getSessionDir());
		expect(buildClmArchive(reopened).items.map(item => [item.id, item.text])).toEqual(
			archive.items.map(item => [item.id, item.text]),
		);
		await reopened.close();
		await sm.close();
	});
	it("does not confuse a literal digest marker with the large content it identifies", () => {
		const sm = manager();
		const huge = "x".repeat(600_000);
		const literal = `[archive-string:${Bun.hash(huge).toString(16)}]`;
		for (const message of [
			...exchange(1, "large", "bash", { command: "cat log" }, huge),
			...exchange(3, "literal", "bash", { command: "cat log" }, literal),
		])
			sm.appendMessage(message);
		const archive = buildClmArchive(sm);
		expect(archive.items.filter(item => item.toolName === "bash").map(item => item.text)).toEqual(
			[huge, literal].map(text => `bash({"command":"cat log"})\n[toolResult bash]\n${text}`),
		);
	});
	it("uses resolved file provenance after a runtime cwd change", () => {
		const sm = manager();
		const original = `${sm.getCwd()}/a.ts`;
		const read = exchange(1, "read", "read", { path: "a.ts:1-20" }, "old");
		const readResult = read[1];
		if (readResult.role !== "toolResult") throw new Error("Expected result");
		readResult.details = { meta: { source: { type: "path", value: original } } };
		for (const message of read) sm.appendMessage(message);
		sm.setCwdWithoutRelocation(`${sm.getCwd()}/other`);
		for (const message of exchange(3, "write", "write", { path: original, content: "new" }, "written"))
			sm.appendMessage(message);
		const archive = buildClmArchive(sm);
		expect(archive.items.find(item => item.toolName === "read")?.supersededBy).toBe(
			archive.items.find(item => item.toolName === "write")!.id,
		);
	});

	it("matches a suffix-resolved read to an edit of its actual absolute path", () => {
		const sm = manager();
		const actual = `${sm.getCwd()}/src/parser.ts`;
		const read = exchange(1, "read", "read", { path: "parser.ts" }, "old");
		const readResult = read[1];
		if (readResult.role !== "toolResult") throw new Error("Expected result");
		readResult.details = { resolvedPath: actual };
		for (const message of [
			...read,
			...exchange(3, "edit", "edit", { path: actual, old_string: "old", new_string: "new" }, "applied"),
		])
			sm.appendMessage(message);
		const archive = buildClmArchive(sm);
		expect(archive.items.find(item => item.toolName === "read")?.supersededBy).toBe(
			archive.items.find(item => item.toolName === "edit")!.id,
		);
	});
	it("ignores lossily persisted tool-result metadata in content identity", async () => {
		const sm = manager();
		const messages = exchange(1, "read", "read", { path: "a.ts" }, "complete output");
		const last = messages[1];
		if (last.role !== "toolResult") throw new Error("Expected tool result");
		last.details = { trace: "x".repeat(600_000) };
		for (const message of messages) sm.appendMessage(message);
		const before = buildClmArchive(sm);
		await sm.flush();
		const reopened = await SessionManager.open(sm.getSessionFile()!, sm.getSessionDir());
		const after = buildClmArchive(reopened);
		expect(after.items.map(item => [item.id, item.truncated])).toEqual(
			before.items.map(item => [item.id, item.truncated]),
		);
		await reopened.close();
		await sm.close();
	});
	it("counts repeated user turns even when their content deduplicates", () => {
		const sm = manager();
		const messages: Message[] = [
			{ role: "user", content: "continue", timestamp: 1 },
			...exchange(2, "a", "read", { path: "a.ts" }, "a"),
			{ role: "user", content: "continue", timestamp: 4 },
			...exchange(5, "b", "read", { path: "b.ts" }, "b"),
			{ role: "user", content: "different", timestamp: 7 },
		];
		for (const message of messages) sm.appendMessage(message);
		const archive = buildClmArchive(sm);
		expect(archive.items.find(item => item.label === "read b.ts")?.turn).toBe(2);
		expect(archive.items.find(item => item.label === "different")?.turn).toBe(3);
		expect(archive.items.find(item => item.text === "continue")?.occurrences).toBe(2);
	});

	it("does not lose a later mutation when an identical write deduplicates", () => {
		const sm = manager();
		const messages = [
			...exchange(1, "write1", "write", { path: "a.ts", content: "new" }, "written"),
			...exchange(3, "read", "read", { path: "a.ts" }, "new"),
			...exchange(5, "write2", "write", { path: "a.ts", content: "new" }, "written"),
		];
		for (const message of messages) sm.appendMessage(message);
		const archive = buildClmArchive(sm);
		const write = archive.items.find(item => item.toolName === "write")!;
		expect(archive.items.find(item => item.toolName === "read")?.supersededBy).toBe(write.id);
		expect(write.supersededBy).toBeUndefined();
	});

	for (const [mode, args] of Object.entries({
		replace: { path: "a.ts", old_string: "old", new_string: "new" },
		patch: { path: "a.ts", edits: [{ op: "update", diff: "@@\n-old\n+new\n" }] },
		apply: { input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch" },
	})) {
		it(`marks a read superseded by an edit in ${mode} mode`, () => {
			const sm = manager();
			for (const message of [
				...exchange(1, "read", "read", { path: "a.ts:1-20" }, "old"),
				...exchange(3, "edit", "edit", args, "applied"),
			])
				sm.appendMessage(message);
			const archive = buildClmArchive(sm);
			expect(archive.items.find(item => item.toolName === "read")?.supersededBy).toBe(
				archive.items.find(item => item.toolName === "edit")!.id,
			);
		});
	}

	it("keeps outputs with a common persistence prefix distinct across reload and full-copy recovery", async () => {
		const sm = manager();
		const prefix = "x".repeat(600_000);
		const messages = [
			...exchange(1, "a", "bash", { command: "cat log" }, `${prefix} FIRST_TAIL`),
			...exchange(3, "b", "bash", { command: "cat log" }, `${prefix} SECOND_TAIL`),
		];
		for (const message of messages) sm.appendMessage(message);
		const full = buildClmArchive(sm);
		expect(full.items.filter(item => item.toolName === "bash").map(item => item.text)).toEqual(
			messages
				.filter(message => message.role === "toolResult")
				.map(
					message =>
						`bash({"command":"cat log"})\n[toolResult bash]\n${message.content[0].type === "text" ? message.content[0].text : ""}`,
				),
		);
		await sm.flush();
		const reopened = await SessionManager.open(sm.getSessionFile()!, sm.getSessionDir());
		const truncated = buildClmArchive(reopened, { live: [] });
		expect(truncated.items.map(item => item.id)).toEqual(full.items.map(item => item.id));
		const recovered = buildClmArchive(reopened, { live: messages });
		expect(recovered.items.map(item => [item.id, item.text])).toEqual(full.items.map(item => [item.id, item.text]));
		await reopened.close();
		await sm.close();
	});
});
