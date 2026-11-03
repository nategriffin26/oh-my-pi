import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Judge, JudgmentRequest, JudgmentResult, Message, Questions } from "@oh-my-pi/pi-ai";
import { Settings } from "../src/config/settings";
import { buildClmArchive } from "../src/session/clm-archive";
import { rankClmArchive } from "../src/session/clm-archive-search";
import { ClmContext } from "../src/session/clm-context";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { ReadTool } from "../src/tools/read";

function archiveOf(calls: Array<[string, Record<string, unknown>, string]>) {
	const manager = SessionManager.inMemory("/tmp");
	const messages: Message[] = [];
	for (const [index, [name, args, output]] of calls.entries()) {
		const id = `call${index}`;
		const call: AssistantMessage = {
			role: "assistant",
			api: "mock",
			provider: "mock",
			model: "archive",
			stopReason: "toolUse",
			timestamp: index * 10 + 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{ type: "toolCall", id, name, arguments: args }],
		};
		messages.push(call, {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: index * 10 + 2,
		});
	}
	for (const message of messages) manager.appendMessage(message);
	return { manager, messages, archive: buildClmArchive(manager, { live: messages }) };
}

describe("archive multiline rendering adversaries", () => {
	it.each(["EOF\r\nEOF1\r\ntail", "first\r\nEOF\r", "EOF\nEOF1\nEOF2\n"])(
		"keeps CRLF and LF delimiter-shaped body lines inside their heredoc: %j",
		content => {
			const { archive } = archiveOf([["write", { path: "body.txt", content }, "written"]]);
			const text = archive.items[0].text;
			const header = /^content: <<(EOF\d*)$/m.exec(text)!;
			const delimiter = header[1];
			const bodyLines = content.split("\n").map(line => line.replace(/\r$/, ""));
			expect(bodyLines).not.toContain(delimiter);
			const start = text.indexOf(header[0]) + header[0].length + 1;
			const end = text.indexOf(`\n${delimiter}\n[toolResult write]`, start);
			expect(text.slice(start, end)).toBe(content.endsWith("\n") ? content.slice(0, -1) : content);
		},
	);

	it("distinguishes nested paths from literal punctuation and newline-bearing keys", () => {
		const args = {
			tasks: [{ task: "first\nsecond" }],
			"tasks[0].task": "literal\nkey",
			"a.b": "dot\nkey",
			a: { b: "nested\nvalue" },
			"evil\nEOF\nkey": "safe\nbody",
		};
		const { archive } = archiveOf([["task", args, "done"]]);
		const text = archive.items[0].text;
		const head = JSON.parse(text.slice("task(".length, text.indexOf("\n") - 1));
		expect(head.tasks[0].task).toBe("<<tasks[0].task");
		expect(head["tasks[0].task"]).toBe('<<["tasks[0].task"]');
		expect(head["a.b"]).toBe('<<["a.b"]');
		expect(head.a.b).toBe("<<a.b");
		expect(text).toContain("tasks[0].task: <<EOF\nfirst\nsecond\nEOF");
		expect(text).toContain('["evil\\nEOF\\nkey"]: <<EOF\nsafe\nbody\nEOF');
	});

	it("renders a huge argument with a dense run of occupied delimiters without losing its final lines", () => {
		const content = Array.from({ length: 30_000 }, (_, i) => (i === 0 ? "EOF" : `EOF${i}`)).join("\n");
		const { archive } = archiveOf([["write", { path: "huge.txt", content }, "written"]]);
		const text = archive.items[0].text;
		expect(text).toContain(`content: <<EOF30000\n${content}\nEOF30000\n[toolResult write]\nwritten`);
	});

	it("reads real body lines through the actual archive URL selector without changing the golden id", async () => {
		const { manager, messages, archive } = archiveOf([
			["write", { path: "notes.md", content: "alpha\nbeta\n" }, "Wrote notes.md"],
		]);
		const item = archive.items[0];
		expect(item.id).toBe("h8c33f67b31");
		const clm = new ClmContext({
			manager,
			enabled: () => true,
			epoch: () => "initial",
			isDisposed: () => false,
			isStreaming: () => false,
			model: () => undefined,
			messages: () => messages,
			estimate: value => JSON.stringify(value).length,
			assertFits: () => {},
			persistTurn: async () => true,
			publish: () => {},
			notice: () => {},
		});
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => manager.getSessionId(),
			sessionManager: manager,
			clmContext: clm,
		};
		const result = await new ReadTool(session).execute("body-lines", {
			path: `context://self/archive/${item.id}:raw:3-4`,
		});
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(text).toStartWith("alpha\nbeta");
		expect(text).not.toContain("content: <<EOF");
		expect(text).not.toContain("Wrote notes.md");
	});
});

describe("archive repeated mutation supersession", () => {
	it("keeps the final repeated write current while earlier distinct content leads to it", () => {
		const { archive } = archiveOf([
			["read", { path: "state.txt" }, "original"],
			["write", { path: "state.txt", content: "alpha" }, "written"],
			["write", { path: "state.txt", content: "beta" }, "written"],
			["write", { path: "state.txt", content: "alpha" }, "written"],
		]);
		const [read, alpha, beta] = archive.items;
		expect(read.supersededBy).toBe(alpha.id);
		expect(beta.supersededBy).toBe(alpha.id);
		expect(alpha.supersededBy).toBeUndefined();
		expect(alpha.occurrences).toBe(2);
	});

	it("keeps every supersession edge forward in last occurrence order with overlapping repeated shell writes", () => {
		const { archive } = archiveOf([
			["read", { path: "a.txt" }, "original a"],
			["read", { path: "b.txt" }, "original b"],
			["bash", { command: "printf alpha | tee a.txt b.txt" }, ""],
			["bash", { command: "printf beta > a.txt" }, ""],
			["bash", { command: "printf gamma > b.txt" }, ""],
			["bash", { command: "printf alpha | tee a.txt b.txt" }, ""],
			["bash", { command: "printf beta > a.txt" }, ""],
		]);
		const [, , alpha, beta, gamma] = archive.items;
		expect(alpha.supersededBy).toBeUndefined();
		expect(gamma.supersededBy).toBe(alpha.id);
		expect(beta.supersededBy).toBeUndefined();
		for (const item of archive.items) {
			if (item.supersededBy) expect(archive.get(item.supersededBy)!.lastSeen).toBeGreaterThan(item.lastSeen);
		}
	});

	it("retains the current b-file answer when only a is rewritten after an aggregate shell write", async () => {
		const { archive } = archiveOf([
			["read", { path: "b.txt" }, "B_SETTING = 10"],
			["bash", { command: "printf 'flag is 55 percent' | tee a.txt b.txt" }, "flag is 55 percent"],
			["bash", { command: "printf 'newest a only' > a.txt" }, ""],
		]);
		const [staleB, currentB, newestA] = archive.items;
		const judge: Judge = {
			label: "partial-path-regression",
			async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
				const state = request.state as { passages: Record<string, string> };
				const answers = Object.fromEntries(
					Object.keys(request.questions).map(id => {
						const passage = state.passages[id];
						const p = passage.includes("55 percent") ? 0.95 : passage.includes("B_SETTING = 10") ? 0.9 : 0.05;
						return [id, { type: "noul", noul: p }];
					}),
				);
				return {
					api: "stub",
					provider: "stub",
					model: "stub",
					answers,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} as JudgmentResult<Q>;
			},
		};
		const result = await rankClmArchive(archive, { query: "B_SETTING", judge });
		expect(result.hits[0].item.id).toBe(currentB.id);
		expect(result.hits.map(hit => hit.item.id)).toEqual([currentB.id, staleB.id]);
		expect(staleB.supersededBy).toBe(currentB.id);
		expect(currentB.supersededBy).toBeUndefined();
		expect(newestA.supersededBy).toBeUndefined();
	});

	it("marks an aggregate stale only when a single later mutation replaces all its paths", () => {
		const { archive } = archiveOf([
			["bash", { command: "printf alpha | tee a.txt b.txt" }, ""],
			["bash", { command: "printf beta | tee a.txt b.txt" }, ""],
			["write", { path: "a.txt", content: "new a" }, "written"],
			["write", { path: "b.txt", content: "new b" }, "written"],
		]);
		const [alpha, beta] = archive.items;
		expect(alpha.supersededBy).toBe(beta.id);
		expect(beta.supersededBy).toBeUndefined();
	});
});
