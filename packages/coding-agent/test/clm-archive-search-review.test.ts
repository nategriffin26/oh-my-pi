import { describe, expect, it } from "bun:test";
import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions, Usage } from "@oh-my-pi/pi-ai";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import type { ClmArchive, ClmArchiveItem } from "../src/session/clm-archive";
import { rankClmArchive, searchClmArchive } from "../src/session/clm-archive-search";

function archive(texts: string[], supersessions: Readonly<Record<number, number>> = {}): ClmArchive {
	const items: ClmArchiveItem[] = texts.map((text, index) => ({
		id: `h${index.toString(16).padStart(10, "0")}`,
		kind: "tool",
		role: "toolResult",
		label: "archived output",
		text,
		tokens: 0,
		timestamp: index + 1,
		lastSeen: index + 1,
		occurrences: 1,
		turn: 1,
		inContext: false,
		...(supersessions[index] === undefined
			? {}
			: { supersededBy: `h${supersessions[index].toString(16).padStart(10, "0")}` }),
	}));
	return { items, get: id => items.find(item => item.id === id), idsFor: () => [] };
}
function judgeWith(
	run: (request: JudgmentRequest, options?: JudgeOptions) => Promise<{ p: number; usage?: Usage }>,
): Judge {
	return {
		label: "review judge",
		async judge<Q extends Questions>(
			request: JudgmentRequest<Q>,
			options?: JudgeOptions,
		): Promise<JudgmentResult<Q>> {
			const { p, usage } = await run(request, options);
			return {
				api: "local",
				provider: "local",
				model: "local",
				answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: p }])),
				usage: usage ?? {
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
}

describe("archive v2 search review", () => {
	it("limits the complete serialized scan input and reports newest-only truncation", async () => {
		const data = archive(Array.from({ length: 2000 }, (_, i) => `other topic ${i} ${"漢字かな文字 ".repeat(30)}`));
		const query = `needle ${"α β γ δ ".repeat(1500)}`;
		let tokens = 0;
		const judge = judgeWith(async request => {
			tokens +=
				countTokens(JSON.stringify(request.state), Encoding.Jev) +
				Object.values(request.questions).reduce((n, q) => n + countTokens(JSON.stringify(q), Encoding.Jev), 0);
			return { p: 0.1 };
		});
		const result = await rankClmArchive(data, { query, judge });
		expect(result.mode).toBe("jev");
		expect(tokens).toBeLessThanOrEqual(100_000);
		expect(result.scanned).toBeLessThan(data.items.length);
		const rendered = await searchClmArchive(data, { query, judge });
		expect(rendered).toMatch(/scan.*(?:truncated|budget)/i);
	});
	it("bounds judge fanout and request starts even with almost-full per-branch queries", async () => {
		const data = archive(
			Array.from(
				{ length: 64 },
				(_, i) =>
					`evidence ${i}\n${Array.from({ length: 45 }, () => `needle ${"漢字かな文字 ".repeat(25)}`).join("\n")}`,
			),
		);
		let active = 0,
			maxActive = 0;
		const starts: number[] = [];
		// Real request-start timestamps exercise the platform-clock rate limiter, not a guessed wait.
		const judge = judgeWith(async () => {
			starts.push(performance.now());
			active++;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			active--;
			return { p: 0.9 };
		});
		const result = await rankClmArchive(data, { query: `needle ${"α β γ δ ".repeat(5000)}`, judge });
		expect(result.mode).toBe("jev");
		expect(maxActive).toBeLessThanOrEqual(4);
		expect(starts.every((start, index) => index < 40 || start - starts[index - 40] >= 999)).toBe(true);
	});
	it("retains billed usage on scan failure and discloses the failed scan with no lexical evidence", async () => {
		const data = archive(["needle evidence", "irrelevant output"]);
		let calls = 0;
		const billed: Usage = {
			input: 17,
			output: 3,
			cacheRead: 4,
			cacheWrite: 0,
			totalTokens: 24,
			cost: { input: 0.02, output: 0.01, cacheRead: 0.005, cacheWrite: 0, total: 0.035 },
		};
		const judge = judgeWith(async () => {
			if (++calls === 2) throw new Error("scan unavailable");
			return { p: 0.1, usage: billed };
		});
		const result = await rankClmArchive(data, { query: "needle", judge });
		expect(result.mode).toBe("lexical");
		expect(result.judge).toMatchObject({ requests: 2, tokens: 21, costUsd: 0.035 });
		expect(result.hits[0].item.id).toBe(data.items[0].id);
		const text = await searchClmArchive(data, {
			query: "absentidentifier",
			judge: judgeWith(async () => {
				throw new Error("scan unavailable");
			}),
		});
		expect(text).toContain("scan unavailable");
	});
	it("pulls the current end of a supersession chain even when an intermediate has high relevance", async () => {
		const data = archive(["needle old value", "intermediate value", "current value"], { 0: 1, 1: 2 });
		const result = await rankClmArchive(data, { query: "needle", judge: judgeWith(async () => ({ p: 0.9 })) });
		expect(result.hits[0].item.id).toBe(data.items[2].id);
		expect(result.shortlist.filter(hit => hit.origin === "superseder").map(hit => hit.id)).toContain(
			data.items[2].id,
		);
	});
	it("aborts queued sibling requests when one judge request fails", async () => {
		const data = archive(
			Array.from(
				{ length: 64 },
				(_, i) =>
					`needle ${i}\n${Array.from({ length: 45 }, () => `needle ${"漢字かな文字 ".repeat(25)}`).join("\n")}`,
			),
		);
		let calls = 0;
		let signal: AbortSignal | undefined;
		const judge = judgeWith(async (_request, options) => {
			calls++;
			signal = options?.signal;
			throw new Error("judge rejected batch");
		});
		const result = await rankClmArchive(data, { query: `needle ${"α β γ δ ".repeat(5000)}`, judge });
		expect(result.mode).toBe("lexical");
		expect(calls).toBe(1);
		expect(signal?.aborted).toBe(true);
	});
});
