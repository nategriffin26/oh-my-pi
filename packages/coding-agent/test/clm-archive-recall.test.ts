import { afterEach, describe, expect, it } from "bun:test";
import type {
	AssistantMessage,
	Judge,
	JudgmentRequest,
	JudgmentResult,
	Message,
	Model,
	Questions,
} from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildClmArchive, type ClmArchive, type ClmArchiveItem } from "../src/session/clm-archive";
import { rankClmArchive, searchClmArchive } from "../src/session/clm-archive-search";
import { SessionManager } from "../src/session/session-manager";

const usage = (input: number) => ({
	input,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const temps: TempDir[] = [];
afterEach(() => {
	for (const temp of temps.splice(0)) temp.removeSync();
});

/** Journal one tool call per entry: `[name, args, output, isError?]`. */
function archiveOf(calls: Array<[string, Record<string, unknown>, string, boolean?]>): ClmArchive {
	const temp = TempDir.createSync("omp-clm-recall-");
	temps.push(temp);
	const manager = SessionManager.create(temp.path(), temp.path());
	const messages: Message[] = [{ role: "user", content: "start", timestamp: 1 }];
	calls.forEach(([name, args, output, isError = false], index) => {
		const id = `c${index}`;
		const call: AssistantMessage = {
			role: "assistant",
			api: "mock",
			provider: "mock",
			model: "recall",
			stopReason: "toolUse",
			timestamp: 10 + index * 10,
			usage: usage(0),
			content: [{ type: "toolCall", id, name, arguments: args }],
		};
		messages.push(call, {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: output }],
			isError,
			timestamp: 15 + index * 10,
		});
	});
	for (const message of messages) manager.appendMessage(message);
	return buildClmArchive(manager, { live: messages });
}

function byLabel(archive: ClmArchive, label: string): ClmArchiveItem {
	const item = archive.items.find(candidate => candidate.label === label);
	if (!item) throw new Error(`no item labelled ${label}: ${archive.items.map(entry => entry.label).join(" | ")}`);
	return item;
}

function items(...specs: Array<{ text: string; supersededBy?: string; tokens?: number }>): ClmArchive {
	const list: ClmArchiveItem[] = specs.map((spec, index) => ({
		id: `h${index.toString(16).padStart(10, "0")}`,
		kind: "tool",
		role: "toolResult",
		toolName: "read",
		label: `read file${index}.ts`,
		text: spec.text,
		tokens: spec.tokens ?? 10,
		timestamp: (index + 1) * 1000,
		lastSeen: (index + 1) * 1000,
		occurrences: 1,
		turn: 1,
		inContext: false,
		...(spec.supersededBy ? { supersededBy: spec.supersededBy } : {}),
	}));
	return { items: list, get: id => list.find(item => item.id === id), idsFor: () => [] };
}

/** Answers every noul with `p(passage)`; records each request's passages. */
function judgeBy(
	p: (passage: string) => number,
	provider = "stub",
	model = "stub",
): Judge & { seen: Record<string, string>[] } {
	const seen: Record<string, string>[] = [];
	return {
		label: "stub",
		seen,
		async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
			const state = request.state;
			const passages: Record<string, string> =
				typeof state === "object" && state !== null && "passages" in state && typeof state.passages === "object"
					? Object.fromEntries(Object.entries(state.passages ?? {}).map(([id, text]) => [id, String(text)]))
					: {};
			seen.push(passages);
			const answers = Object.fromEntries(
				Object.keys(request.questions).map(id => [id, { type: "noul", noul: p(passages[id] ?? "") }]),
			);
			return { api: "stub", provider, model, answers, usage: usage(1_000) } as JudgmentResult<Q>;
		},
	};
}

describe("archive item rendering", () => {
	it("renders multi-line args verbatim so line numbers address real lines, without moving ids", async () => {
		const archive = archiveOf([["write", { path: "notes.md", content: "alpha\nbeta\n" }, "Wrote notes.md"]]);
		const item = byLabel(archive, "write notes.md");
		// Same id the one-line JSON rendering produced: ids are part of the persisted archive contract.
		expect(item.id).toBe("h8c33f67b31");
		expect(item.text.split("\n")).toEqual([
			'write({"path":"notes.md","content":"<<content"})',
			"content: <<EOF",
			"alpha",
			"beta",
			"EOF",
			"[toolResult write]",
			"Wrote notes.md",
		]);
		expect((await searchClmArchive(archive, { query: "beta", rerank: false })).text).toContain("L4: beta");
	});

	it("picks a heredoc delimiter the content does not contain", () => {
		const archive = archiveOf([["bash", { command: "cat <<EOF\nx\nEOF" }, "x"]]);
		expect(archive.items.at(-1)!.text).toContain("command: <<EOF1\ncat <<EOF\nx\nEOF\nEOF1");
	});
});

describe("archive supersession by shell rewrites", () => {
	it("marks a read stale after a successful sed -i of that file only", () => {
		const archive = archiveOf([
			["read", { path: "src/a.ts" }, "export const LIMIT = 1;"],
			["read", { path: "src/b.ts" }, "export const OTHER = 1;"],
			["bash", { command: "grep LIMIT src/b.ts > /dev/null" }, ""],
			["bash", { command: "sed -i 's/= 1;/= 2;/' src/a.ts" }, ""],
			["bash", { command: "sed -i 's/= 1;/= 3;/' src/b.ts" }, "sed: permission denied", true],
		]);
		const sed = byLabel(archive, "bash sed -i 's/= 1;/= 2;/' src/a.ts");
		expect(byLabel(archive, "read src/a.ts").supersededBy).toBe(sed.id);
		// Neither a redirect to /dev/null nor a failed rewrite changes src/b.ts.
		expect(byLabel(archive, "read src/b.ts").supersededBy).toBeUndefined();
	});

	it("supersedes the redirect target, not the file read", () => {
		const archive = archiveOf([
			["read", { path: "a.txt" }, "alpha"],
			["read", { path: "b.txt" }, "beta"],
			["bash", { command: "cat a.txt > b.txt" }, ""],
		]);
		expect(byLabel(archive, "read a.txt").supersededBy).toBeUndefined();
		expect(byLabel(archive, "read b.txt").supersededBy).toBe(byLabel(archive, "bash cat a.txt > b.txt").id);
	});

	it("supersedes an earlier run of the same command in the same directory with a later successful one", () => {
		const archive = archiveOf([
			["bash", { command: "bun test  src/parser" }, "3 fail: expected 2 got 3", true],
			["bash", { command: "bun test src/parser", cwd: "pkg" }, "1 fail in pkg"],
			["bash", { command: "bun test src/parser" }, "12 pass, 0 fail"],
			["bash", { command: "bun test src/parser" }, "network flake", true],
		]);
		const failing = archive.items.find(item => item.text.includes("expected 2 got 3"))!;
		const passing = archive.items.find(item => item.text.includes("12 pass"))!;
		// Whitespace differences do not make a different command; a later failed rerun refreshes nothing.
		expect(failing.supersededBy).toBe(passing.id);
		expect(passing.supersededBy).toBeUndefined();
		// The same command in another directory observes something else.
		expect(archive.items.find(item => item.text.includes("1 fail in pkg"))!.supersededBy).toBeUndefined();
	});

	it("supersedes a read with a later read of the same path and range that shows different content", () => {
		const archive = archiveOf([
			["read", { path: "src/a.ts:1-20" }, "LIMIT = 1"],
			["read", { path: "src/a.ts:40-60" }, "OTHER = 7"],
			["read", { path: "src/a.ts:1-20" }, "LIMIT = 2"],
			["read", { path: "src/a.ts:40-60" }, "missing file", true],
		]);
		const [, first, other, second] = archive.items;
		expect(first.supersededBy).toBe(second.id);
		// Another range, and a failed read, change nothing.
		expect(other.supersededBy).toBeUndefined();
		expect(second.supersededBy).toBeUndefined();
	});
});

describe("archive recall ranking", () => {
	it("never ranks a superseded item above its kept superseder, judged or lexical", async () => {
		const archive = items(
			{ text: "payload size limit is 25 MB; the size limit applies per payload", supersededBy: "h0000000001" },
			{ text: "payload limit: 100 MB" },
		);
		const [stale, current] = archive.items;
		const judge = judgeBy(passage => (passage.includes("25 MB") ? 0.95 : 0.9));
		const judged = await rankClmArchive(archive, { query: "payload size limit", judge });
		expect(judged.mode).toBe("jev");
		expect(judged.hits.map(hit => hit.item.id)).toEqual([current.id, stale.id]);
		expect(judged.hits.map(hit => hit.p)).toEqual([0.9, 0.95]);
		const lexical = await rankClmArchive(archive, { query: "payload size limit", rerank: false });
		expect(lexical.shortlist[0]).toMatchObject({ id: stale.id, lexicalRank: 1 });
		expect(lexical.hits.map(hit => hit.item.id)).toEqual([current.id, stale.id]);
	});

	it("judges the superseder of a stale match even when it shares no query term, marking the stale passage", async () => {
		const archive = items({ text: "ROLLOUT_PCT = 10", supersededBy: "h0000000001" }, { text: "flag at 55 percent" });
		const judge = judgeBy(passage => (passage.includes("55") ? 0.9 : 0.85));
		const result = await rankClmArchive(archive, { query: "ROLLOUT_PCT", judge });
		expect(result.shortlist.map(candidate => [candidate.id, candidate.origin])).toEqual([
			["h0000000000", "lexical"],
			["h0000000001", "superseder"],
		]);
		expect(result.hits.map(hit => hit.item.id)).toEqual(["h0000000001", "h0000000000"]);
		expect(judge.seen[0].h0000000000).toStartWith(
			"tool read: read file0.ts [superseded by h0000000001 at 1970-01-01T00:00:02Z]",
		);
	});

	it("scans the rest of the archive when no lexical candidate is relevant", async () => {
		const archive = items(
			{ text: "curl: (60) SSL certificate problem: certificate has expired" },
			{ text: "environment variables loaded" },
			{ text: "unrelated build output" },
		);
		const judge = judgeBy(passage => (passage.includes("certificate has expired") ? 0.9 : 0.1));
		const result = await rankClmArchive(archive, {
			query: "Why couldn't we reach the pre-production environment?",
			judge,
		});
		expect(result.matches).toBe(1);
		expect(result.scanned).toBe(2);
		expect(result.hits[0]).toMatchObject({ item: { id: "h0000000000" }, origin: "scan", p: 0.9 });
		const text = (
			await searchClmArchive(archive, {
				query: "Why couldn't we reach the pre-production environment?",
				judge,
			})
		).text;
		expect(text).toContain("Jev label scan of 2 more");
		expect(text).toContain("{relevance p=0.90, label scan}");
	});

	it("still scans when a lexical distractor looks confidently relevant", async () => {
		const archive = items(
			{ text: "curl: (60) SSL certificate problem: certificate has expired" },
			{ text: "pre-production environment notes: reach it through the VPN" },
		);
		const judge = judgeBy(passage => (passage.includes("certificate has expired") ? 0.95 : 0.85));
		const result = await rankClmArchive(archive, {
			query: "Why couldn't we reach the pre-production environment?",
			judge,
		});
		expect(result.scanned).toBe(1);
		expect(result.hits.map(hit => [hit.item.id, hit.origin])).toEqual([
			["h0000000000", "scan"],
			["h0000000001", "lexical"],
		]);
	});

	it("keeps at most four judge requests in flight across the concurrent rerank and scan", async () => {
		const specs = [
			...Array.from({ length: 80 }, (_, index) => ({ text: `ZEBRA_TOKEN row ${index}` })),
			...Array.from({ length: 1_500 }, (_, index) => ({ text: `filler line ${index} ${"x".repeat(200)}` })),
		];
		const archive = items(...specs);
		let active = 0;
		let peak = 0;
		let requests = 0;
		const inner = judgeBy(() => 0.1);
		const judge: Judge = {
			label: "concurrency",
			async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
				active++;
				requests++;
				peak = Math.max(peak, active);
				// Request starts are paced by the real clock (25 ms apart); only requests outlasting that pace overlap.
				await Bun.sleep(120);
				active--;
				return inner.judge(request);
			},
		};
		const result = await rankClmArchive(archive, { query: "ZEBRA_TOKEN", judge });
		expect(result.judge!.requests).toBe(requests);
		expect(requests).toBeGreaterThan(5);
		expect(result.scanned).toBeGreaterThan(0);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(4);
	});

	it("prices unbilled judge usage from the judge's catalog model", async () => {
		const archive = items({ text: "ZEBRA_TOKEN = 42" });
		const judgeModel = { cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model;
		const explicit = await rankClmArchive(archive, { query: "ZEBRA_TOKEN", judge: judgeBy(() => 0.97), judgeModel });
		expect(explicit.judge).toMatchObject({ requests: 1, tokens: 1_000 });
		expect(explicit.judge!.costUsd).toBeCloseTo(0.0005, 12);
		// Without an explicit model, the bundled catalog entry of the responding provider/model prices it.
		const bundled = await rankClmArchive(archive, {
			query: "ZEBRA_TOKEN",
			judge: judgeBy(() => 0.97, "typesafe", "jev-latest"),
		});
		expect(bundled.judge!.costUsd).toBeGreaterThan(0);
		const unknown = await rankClmArchive(archive, { query: "ZEBRA_TOKEN", judge: judgeBy(() => 0.97) });
		expect(unknown.judge!.costUsd).toBe(0);
	});
});

describe("archive search excerpts", () => {
	it("points at the line holding a rare query term and says when the excerpt is partial", async () => {
		const rows = Array.from({ length: 24 }, (_, index) => `replica-${index + 1} lag ${index * 3} ms`);
		const archive = items(
			{ text: ["# replication report", ...rows, "worst: replica-17"].join("\n"), tokens: 5_000 },
			{ text: "lag ok" },
		);
		const text = (await searchClmArchive(archive, { query: "worst replica lag", rerank: false })).text;
		// Every row names a replica and its lag; only the footer says which is worst.
		expect(text).toContain("L26: worst: replica-17");
		expect(text).toContain(
			"(excerpt: 6 of 26 lines — read context://self/archive/h0000000000 before answering exact questions)",
		);
		// A fully shown item carries no partial-excerpt note.
		expect(text).not.toContain("archive/h0000000001 before answering");
	});

	it("shows a small best hit whole so a table is never answered from its first rows", async () => {
		const rows = Array.from({ length: 24 }, (_, index) => `replica-${index + 1} lag ${index * 3} ms`);
		const archive = items(
			{ text: ["# replication lag report", ...rows].join("\n"), tokens: 400 },
			{ text: "replication lag dashboard link", tokens: 5_000 },
		);
		const text = (await searchClmArchive(archive, { query: "replication lag report", rerank: false })).text;
		// Row 15 shares no rare term with the query, yet the whole item is inline.
		expect(text).toContain("L16: replica-15 lag 42 ms");
		expect(text).not.toContain("archive/h0000000000 before answering");
	});
});
