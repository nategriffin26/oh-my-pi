import { describe, expect, it } from "bun:test";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import type { ClmArchive, ClmArchiveItem } from "../src/session/clm-archive";
import { searchClmArchive } from "../src/session/clm-archive-search";

function archive(texts: string[]): ClmArchive {
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
	}));
	return { items, get: id => items.find(item => item.id === id), idsFor: () => [] };
}

function acceptingJudge(inspect?: (request: JudgmentRequest) => void): Judge {
	return {
		label: "local adversarial judge",
		async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
			inspect?.(request);
			return {
				api: "local",
				provider: "local",
				model: "local",
				answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "noul", noul: 0.9 }])),
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
}

const stalledJudge: Judge = { label: "non-cooperative judge", judge: () => Promise.withResolvers<never>().promise };

describe("archive search adversarial boundaries", () => {
	it("retains prototype-named identifiers alongside other query terms", async () => {
		const data = archive(["constructor sets up the parser", "needle marker"]);
		const result = (await searchClmArchive(data, { query: "constructor needle", rerank: false })).text;
		expect(result).toContain(`${data.items[0].id} `);
		expect(result).toContain(`${data.items[1].id} `);
	});

	it("retrieves CJK words embedded in unspaced sentences and single characters", async () => {
		const data = archive(["修复缓存失效的问题", "雨", "캐시가잘못되었습니다"]);
		const result = (await searchClmArchive(data, { query: "缓存", rerank: false })).text;
		expect(result).toContain(`${data.items[0].id} `);
		const single = (await searchClmArchive(data, { query: "雨", rerank: false })).text;
		expect(single).toContain(`${data.items[1].id} `);
		expect((await searchClmArchive(data, { query: "캐시", rerank: false })).text).toContain(`${data.items[2].id} `);
	});

	it("matches canonically equivalent Unicode spellings", async () => {
		const data = archive(["cafe\u0301 configuration"]);
		expect((await searchClmArchive(data, { query: "café", rerank: false })).text).toContain(`${data.items[0].id} `);
		const long = archive([`${"a\u0301 ".repeat(600)}needle at the end`]);
		expect((await searchClmArchive(long, { query: "needle", rerank: false })).text).toContain("needle at the end");
	});

	it("returns lexical evidence when a non-cooperative judge exceeds the deadline", async () => {
		const data = archive(["needle evidence"]);
		// AbortSignal.timeout uses the platform clock; an outer watchdog bounds a non-cooperative judge.
		const result = await Promise.race([
			searchClmArchive(data, { query: "needle", judge: stalledJudge, timeoutMs: 5 }).then(search => search.text),
			Bun.sleep(100).then(() => "OUTER WATCHDOG"),
		]);
		expect(result).toContain("rerank failed open");
		expect(result).toContain(`${data.items[0].id} `);
	});

	it("rejects caller cancellation even when the judge ignores its signal", async () => {
		const controller = new AbortController();
		const reason = new Error("caller cancelled archive recall");
		const pending = searchClmArchive(archive(["needle"]), {
			query: "needle",
			judge: stalledJudge,
			signal: controller.signal,
		});
		controller.abort(reason);
		// No completion event exists before the abort race works; the watchdog exposes that regression.
		const result = await Promise.race([pending.catch(error => error), Bun.sleep(100).then(() => "OUTER WATCHDOG")]);
		expect(result).toBe(reason);
	});

	it("does not search or dispatch work for an already-cancelled request", async () => {
		const reason = new Error("already cancelled");
		await expect(
			searchClmArchive(archive(["needle"]), {
				query: "needle",
				rerank: false,
				signal: AbortSignal.abort(reason),
			}),
		).rejects.toBe(reason);
	});

	it("packs the query, criteria, and question instructions within the Jev branch budget", async () => {
		const query = `needle ${"α β γ δ ".repeat(1100)}`;
		const data = archive(
			Array.from(
				{ length: 16 },
				(_, i) =>
					`evidence ${i}\n${Array.from({ length: 45 }, () => `needle ${"α β γ δ ".repeat(25)}`).join("\n")}`,
			),
		);
		const sizes: number[] = [];
		const result = (
			await searchClmArchive(data, {
				query,
				judge: acceptingJudge(request => {
					const state = countTokens(JSON.stringify(request.state), Encoding.Jev);
					for (const question of Object.values(request.questions)) {
						sizes.push(state + countTokens(JSON.stringify(question), Encoding.Jev));
					}
				}),
			})
		).text;
		expect(result.includes("Jev rerank (")).toBe(true);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(24_000);
	});

	it("fails open without dispatching an individually oversized judgment", async () => {
		let calls = 0;
		const result = (
			await searchClmArchive(archive(["needle evidence"]), {
				query: `needle ${"α β γ δ ".repeat(9000)}`,
				judge: acceptingJudge(() => {
					calls++;
				}),
			})
		).text;
		expect(result.includes("rerank failed open")).toBe(true);
		expect(calls).toBe(0);
		expect(result).toContain("L1: needle evidence");
	});

	it("bounds catastrophic JavaScript regex scans instead of reporting a false no-match", async () => {
		const data = archive(Array.from({ length: 6 }, () => `${"a".repeat(32)}!`));
		await expect(searchClmArchive(data, { query: "(a+)+$", regex: true })).rejects.toThrow(
			/regex.*(deadline|timed out)/i,
		);
	});
	it("keeps evidence near the end of a long matching line in the judged passage", async () => {
		const data = archive([`${"unrelated ".repeat(1200)}needle explains the fix`]);
		let judgedPassage = "";
		await searchClmArchive(data, {
			query: "needle",
			judge: acceptingJudge(request => {
				judgedPassage = (request.state as { passages: Record<string, string> }).passages[data.items[0].id];
			}),
		});
		expect(judgedPassage).toContain("needle explains the fix");
	});
});
