/**
 * Recall over the CLM archive: lexical BM25 (or an exact regex filter) picks a wide shortlist,
 * then the native judge (TypeSafe Jev) reranks it with one noul question per item. When no
 * shortlisted item is clearly relevant, a Jev label scan over the rest of the archive adds
 * candidates the lexical gate missed. Any judge failure, timeout, or missing native judge falls
 * back to lexical order and says so. {@link rankClmArchive} returns the ranking as data;
 * {@link searchClmArchive} renders it.
 */
import { Script } from "node:vm";
import type { Judge, JudgmentResult, Model, NoulQuestion } from "@oh-my-pi/pi-ai";
import { TypeSafeJudge } from "@oh-my-pi/pi-ai";
import { calculateCost, getBundledModel, isGeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import recallQuestionTemplate from "../prompts/tools/archive-recall-question.md" with { type: "text" };
import scanQuestionTemplate from "../prompts/tools/archive-recall-scan-question.md" with { type: "text" };
import type { ClmArchiveSearchReadDetails } from "@oh-my-pi/pi-tui/tools/clm-render";
import type { ClmArchive, ClmArchiveItem } from "./clm-archive";
import { CLM_ARCHIVE_ROUTE, clmArchiveRow, clmPreview, renderArchiveManifestLine } from "./clm-archive";

export interface ClmArchiveSearchOptions {
	query: string;
	/** Case-insensitive JavaScript regex: exact filter, never reranked; scan deadline is 1 second. */
	regex?: boolean;
	/** Hits to show; default {@link CLM_ARCHIVE_SEARCH_LIMIT}, at most {@link CLM_ARCHIVE_SEARCH_MAX_LIMIT}. */
	limit?: number;
	/** Rerank the lexical shortlist with `judge`; default true. */
	rerank?: boolean;
	/** Native judge for stage 2; omitted means lexical only. */
	judge?: Judge;
	/**
	 * Catalog model `judge` routes to, pricing responses that report no billed cost. Defaults to
	 * the bundled catalog entry of the response's (or a {@link TypeSafeJudge}'s) provider/model.
	 */
	judgeModel?: Model;
	/** Why no judge was supplied, shown in the result header. */
	judgeUnavailable?: string;
	/** Route the expand hints name; defaults to `context://self/archive`. */
	routePrefix?: string;
	signal?: AbortSignal;
	/** Rerank deadline; lexical order is returned when it passes. */
	timeoutMs?: number;
}

export type ClmArchiveSearchMode = "lexical" | "jev" | "regex";

/** How an item entered the candidate set. */
export type ClmArchiveCandidateOrigin = "lexical" | "superseder" | "scan";

export interface ClmArchiveCandidate {
	id: string;
	/** BM25 rank among all matching items (1 = best); absent for items found another way. */
	lexicalRank?: number;
	/** BM25 score, or the label-scan probability for `scan` candidates. */
	score: number;
	origin: ClmArchiveCandidateOrigin;
	/** Full-passage judge probability (Jev mode). */
	p?: number;
}

export interface ClmArchiveSearchHit {
	item: ClmArchiveItem;
	lexicalRank?: number;
	/** Judge probability that the item holds what the query looks for. */
	p?: number;
	origin?: ClmArchiveCandidateOrigin;
}

export interface ClmArchiveJudgeUsage {
	requests: number;
	/** Input tokens, including cached input; output is not part of the scan input budget. */
	tokens: number;
	/** Billed cost, or input tokens priced from the judge's catalog model when the backend bills nothing. */
	costUsd: number;
	ms: number;
}

export interface ClmArchiveSearchResult {
	query: string;
	mode: ClmArchiveSearchMode;
	/** Why ranking stayed lexical: rerank disabled, no judge, or the judge failed open. */
	fallbackReason?: string;
	/** Items matching lexically (BM25 > 0) or the regex. */
	matches: number;
	/** Candidates in lexical order (regex: empty), then pulled-in superseders and label-scan finds. */
	shortlist: ClmArchiveCandidate[];
	/** Best first, at most `limit` (regex: newest first). Jev with nothing relevant: lexical top as weak evidence. */
	hits: ClmArchiveSearchHit[];
	/** Jev mode: judged items at p ≥ {@link CLM_ARCHIVE_RERANK_THRESHOLD}. */
	relevant?: number;
	/** Items the Jev label scan looked at outside the lexical shortlist. */
	scanned?: number;
	/** Total eligible items when a label scan ran; scanned < scanTotal means newest-only truncation. */
	scanTotal?: number;
	judge?: ClmArchiveJudgeUsage;
}

export const CLM_ARCHIVE_SEARCH_LIMIT = 10;
export const CLM_ARCHIVE_SEARCH_MAX_LIMIT = 50;
/** Lexical candidates the judge sees; a narrow cutoff loses evidence before reranking can recover it. */
export const CLM_ARCHIVE_SHORTLIST = 64;
/** Yes-probability at which a reranked item counts as relevant. */
export const CLM_ARCHIVE_RERANK_THRESHOLD = 0.2;
const RERANK_TIMEOUT_MS = 20_000;
/** Jev rejects a judgment branch past ~33k tokens; reserve transport overhead below that cap. */
const REQUEST_STATE_TOKENS = 24_000;
const PASSAGE_TOKENS = 2_000;
const PASSAGE_CHARS = 8_000;
const QUESTIONS_PER_REQUEST = 16;
/** Judge requests one search keeps in flight across its concurrent rerank and scan. */
const MAX_IN_FLIGHT = 4;
/** Jev input tokens (views plus questions) one label scan may spend, newest items first. */
const SCAN_TOKENS = 100_000;
/** Jev answers ~256 questions per request within one state budget at flat latency. */
const SCAN_QUESTIONS_PER_REQUEST = 256;
const SCAN_VIEW_LINES = 3;
const SCAN_LINE_CHARS = 160;
/** Scan finds at or above this p get a full-passage rerank, best first. */
const SCAN_MIN_P = 0.2;
const SCAN_KEEP = 16;
const EXCERPT_LINES = 6;
const EXCERPT_LINE_CHARS = 200;
/** The best hit at or under this size renders whole: weak models answer from a partial excerpt instead of expanding it. */
const WHOLE_BEST_HIT_TOKENS = 1_500;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const RECALL_CRITERIA = {
	no: "The passage only shares keywords with the search, or covers a different file, command, value, or topic.",
	yes: "The passage holds the content the search looks for (exact output, code, decision, requirement, or explanation), or directly answers or substantively supports it.",
};

const SCAN_CRITERIA = {
	no: "The entry is about a different topic, file, command, or event than the search.",
	yes: "The entry is, or plausibly contains, what the search looks for, even in different words.",
};

const STOPWORDS: Record<string, true> = {
	a: true,
	an: true,
	and: true,
	are: true,
	as: true,
	at: true,
	be: true,
	by: true,
	did: true,
	do: true,
	does: true,
	for: true,
	from: true,
	how: true,
	in: true,
	is: true,
	it: true,
	of: true,
	on: true,
	or: true,
	that: true,
	the: true,
	this: true,
	to: true,
	was: true,
	we: true,
	what: true,
	when: true,
	where: true,
	which: true,
	with: true,
};

const WORD_RE = /[\p{L}\p{N}_$]+(?:[./\\:-]+[\p{L}\p{N}_$]+)*/gu;
const SUBWORD_RE = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+|\p{L}+/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const REGEX_TIMEOUT_MS = 1_000;
// All regex execution (including excerpt scans) stays inside the timed VM, not in host callbacks.
const regexScan = new Script(`
(() => {
  const pattern = new RegExp(query, "i");
  const matches = [];
  for (let i = 0; i < items.length; i++) {
    if (pattern.test(items[i].label) || pattern.test(items[i].text)) matches.push(i);
  }
  const positions = new Map();
  for (const index of matches.slice(-limit)) {
    for (const line of items[index].text.split("\\n")) {
      if (!positions.has(line)) positions.set(line, line.search(pattern));
    }
  }
  return { matches, positions };
})()
`);
/**
 * Code-aware terms: each whole identifier or path (`src/clm-archive.ts`, `fooBar_baz`) plus
 * its separator and camelCase parts, NFC-normalized and lowercased. CJK runs also yield
 * single characters and adjacent pairs so unspaced sentences remain searchable.
 */
export function archiveTerms(text: string): string[] {
	const terms: string[] = [];
	for (const [word] of text.normalize("NFC").matchAll(WORD_RE)) {
		const whole = word.toLowerCase();
		if (whole.length > 1) terms.push(whole);
		for (const [part] of word.matchAll(SUBWORD_RE)) {
			const lower = part.toLowerCase();
			if (lower.length > 1 && lower !== whole) terms.push(lower);
		}
		for (const [run] of word.matchAll(CJK_RE)) {
			const characters = [...run];
			for (let i = 0; i < characters.length; i++) {
				if (characters[i] !== whole || whole.length === 1) terms.push(characters[i]);
				const pair = characters[i] + (characters[i + 1] ?? "");
				if (i + 1 < characters.length && pair !== whole) terms.push(pair);
			}
		}
	}
	return terms;
}

interface LexicalIndex {
	docs: Map<string, number>[];
	lengths: number[];
	averageLength: number;
	documentFrequency: Map<string, number>;
}

const indexes = new WeakMap<ClmArchive, LexicalIndex>();

function lexicalIndex(archive: ClmArchive): LexicalIndex {
	const cached = indexes.get(archive);
	if (cached) return cached;
	const documentFrequency = new Map<string, number>();
	const lengths: number[] = [];
	const docs = archive.items.map(item => {
		const counts = new Map<string, number>();
		const terms = archiveTerms(`${item.label}\n${item.text}`);
		for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
		for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		lengths.push(terms.length);
		return counts;
	});
	const total = lengths.reduce((sum, length) => sum + length, 0);
	const index = { docs, lengths, averageLength: total / Math.max(1, lengths.length), documentFrequency };
	indexes.set(archive, index);
	return index;
}

interface Hit {
	item: ClmArchiveItem;
	lexical: number;
	lexicalRank?: number;
	origin: ClmArchiveCandidateOrigin;
	probability?: number;
}

function bm25(archive: ClmArchive, queryTerms: readonly string[]): Hit[] {
	const index = lexicalIndex(archive);
	const n = archive.items.length;
	const hits: Hit[] = [];
	archive.items.forEach((item, i) => {
		const doc = index.docs[i];
		let score = 0;
		for (const term of queryTerms) {
			const tf = doc.get(term);
			if (!tf) continue;
			const df = index.documentFrequency.get(term) ?? 0;
			const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
			const norm = 1 - BM25_B + (BM25_B * index.lengths[i]) / Math.max(1, index.averageLength);
			score += (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
		}
		if (score > 0) hits.push({ item, lexical: score, origin: "lexical" });
	});
	hits.sort((a, b) => b.lexical - a.lexical || b.item.timestamp - a.item.timestamp);
	hits.forEach((hit, rank) => {
		hit.lexicalRank = rank + 1;
	});
	return hits;
}

/** Stable dependency order, following chains through items outside the kept set. Cycles are bounded. */
function supersessionOrder(archive: ClmArchive, hits: readonly Hit[]): Hit[] {
	const kept = new Map(hits.map(hit => [hit.item.id, hit]));
	const emitted = new Set<string>();
	const ordered: Hit[] = [];
	for (const hit of hits) {
		const chain: Hit[] = [];
		const visited = new Set<string>();
		let item: ClmArchiveItem | undefined = hit.item;
		while (item && !visited.has(item.id) && !emitted.has(item.id)) {
			visited.add(item.id);
			const present = kept.get(item.id);
			if (present) chain.push(present);
			item = item.supersededBy === undefined ? undefined : archive.get(item.supersededBy);
		}
		for (const entry of chain.reverse()) {
			emitted.add(entry.item.id);
			ordered.push(entry);
		}
	}
	return ordered;
}

/** Line matcher for excerpts: a regex, or the count of query terms a line contains. */
type LineScore = (line: string) => number;

interface LineMatcher {
	score: LineScore;
	/** Offset to keep visible when clipping a long line. */
	focus: (line: string) => number;
	/** Normalized query terms; excerpts favor lines holding terms that are rare within the item. */
	terms?: readonly string[];
}

function termLineScore(queryTerms: readonly string[]): LineScore {
	return line => {
		const lower = line.normalize("NFC").toLowerCase();
		let score = 0;
		for (const term of queryTerms) if (lower.includes(term)) score++;
		return score;
	};
}

function clipLine(line: string, focus: number, width = EXCERPT_LINE_CHARS): string {
	if (line.length <= width) return line;
	const start = Math.max(0, Math.min(line.length - width, focus - width / 4));
	return `${start > 0 ? "…" : ""}${line.slice(start, start + width)}${start + width < line.length ? "…" : ""}`;
}

interface Excerpt {
	/** `L<n>:` lines; numbers match `context://self/archive/<id>:N-M`. */
	lines: string[];
	/** The first excerpt line as data (1-based item line, clipped text), for the transcript preview. */
	first?: { line: number; text: string };
	/** Item lines in total. */
	total: number;
	/** Some non-empty line is missing or clipped. */
	partial: boolean;
}

function excerpt(text: string, lines: LineMatcher): Excerpt {
	const all = text.split("\n");
	const lower = lines.terms ? all.map(line => line.normalize("NFC").toLowerCase()) : [];
	// A term on every row (a table's column name) says little; a term on one row points at it.
	const weights: [string, number][] = [];
	for (const term of lines.terms ?? []) {
		const rows = lower.filter(line => line.includes(term)).length;
		if (rows > 0) weights.push([term, 1 / rows]);
	}
	const scored: { index: number; score: number }[] = [];
	all.forEach((line, index) => {
		const value = lines.terms
			? weights.reduce((sum, [term, weight]) => sum + (lower[index].includes(term) ? weight : 0), 0)
			: lines.score(line);
		if (value > 0) scored.push({ index, score: value });
	});
	const chosen =
		scored.length > 0
			? scored
					.sort((a, b) => b.score - a.score || a.index - b.index)
					.slice(0, EXCERPT_LINES)
					.sort((a, b) => a.index - b.index)
			: all
					.map((line, index) => ({ index, score: line.trim() === "" ? 0 : 1 }))
					.filter(line => line.score > 0)
					.slice(0, 3);
	const nonEmpty = all.filter(line => line.trim() !== "").length;
	const clipped = chosen.map(({ index }) => ({
		line: index + 1,
		text: clipLine(all[index], lines.focus(all[index])),
	}));
	return {
		lines: clipped.map(({ line, text }) => `  L${line}: ${text}`),
		first: clipped[0],
		total: all.length,
		partial: chosen.length < nonEmpty || chosen.some(({ index }) => all[index].length > EXCERPT_LINE_CHARS),
	};
}

/** `kind tool: label`, plus when and by what a superseded item was replaced. */
function passageHeader(archive: ClmArchive, item: ClmArchiveItem): string {
	const header = `${item.kind}${item.toolName ? ` ${item.toolName}` : ""}: ${item.label}`;
	if (!item.supersededBy) return header;
	const at = archive.get(item.supersededBy)?.timestamp;
	const when = at !== undefined && Number.isFinite(at) ? ` at ${new Date(at).toISOString().slice(0, 19)}Z` : "";
	return `${header} [superseded by ${item.supersededBy}${when}]`;
}

/** Judge-sized view of one item: header plus matched lines with nearby context, capped in Jev tokens. */
function passage(archive: ClmArchive, item: ClmArchiveItem, lines: LineMatcher): string {
	const all = item.text.split("\n");
	const keep = new Set<number>();
	all.forEach((line, index) => {
		if (lines.score(line) === 0) return;
		for (let i = Math.max(0, index - 2); i <= Math.min(all.length - 1, index + 2); i++) keep.add(i);
	});
	let body =
		keep.size === 0
			? item.text.slice(0, PASSAGE_CHARS)
			: [...keep]
					.sort((a, b) => a - b)
					.map(index => clipLine(all[index], lines.focus(all[index])))
					.join("\n")
					.slice(0, PASSAGE_CHARS);
	const tokens = countTokens(body, Encoding.Jev);
	if (tokens > PASSAGE_TOKENS) body = body.slice(0, Math.floor((body.length * PASSAGE_TOKENS) / tokens));
	return `${passageHeader(archive, item)}\n${body}`;
}

/** Label-scan view: header plus the first few non-empty result lines, skipping the call line. */
function scanView(archive: ClmArchive, item: ClmArchiveItem): string {
	const head = item.text.slice(0, SCAN_VIEW_LINES * SCAN_LINE_CHARS * 4).split("\n");
	const body: string[] = [];
	for (const [index, line] of head.entries()) {
		if (body.length >= SCAN_VIEW_LINES) break;
		const call = index === 0 && item.toolName !== undefined && line.startsWith(`${item.toolName}(`);
		if (call || line.trim() === "" || line.startsWith("[toolResult ")) continue;
		body.push(clipLine(line, 0, SCAN_LINE_CHARS));
	}
	return [passageHeader(archive, item), ...body].join("\n");
}

/** The bundled catalog entry for `provider`/`id`, if any. */
function catalogModel(provider: string, id: string): Model | undefined {
	return isGeneratedProvider(provider) ? getBundledModel(provider, id) : undefined;
}

// Searches sharing one judge share its request-start budget, including across rerank/scan phases.
const judgeDispatch = new WeakMap<Judge, { ready: Promise<void>; lastStart: number }>();

class JudgeMeter {
	readonly usage: ClmArchiveJudgeUsage = { requests: 0, tokens: 0, costUsd: 0, ms: 0 };
	readonly #started = performance.now();
	readonly #judge: Judge;
	readonly #model: Model | undefined;
	readonly #dispatch: { ready: Promise<void>; lastStart: number };
	// Concurrent phases of one search (rerank and scan) share its in-flight request slots.
	#active = 0;
	readonly #waiters: (() => void)[] = [];

	/** Take an in-flight slot, then wait for the judge's next request start; pair with `release`. */
	async start(signal: AbortSignal): Promise<void> {
		while (this.#active >= MAX_IN_FLIGHT) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			await untilAborted(signal, () => promise);
		}
		this.#active++;
		const dispatch = this.#dispatch;
		const pending = dispatch.ready.then(async () => {
			signal.throwIfAborted();
			const delay = 25 - (performance.now() - dispatch.lastStart);
			if (delay > 0) await untilAborted(signal, () => Bun.sleep(Math.ceil(delay)));
			signal.throwIfAborted();
			dispatch.lastStart = performance.now();
			this.usage.requests++;
		});
		dispatch.ready = pending.catch(() => {});
		try {
			await pending;
		} catch (error) {
			this.release();
			throw error;
		}
	}

	release(): void {
		this.#active--;
		this.#waiters.shift()?.();
	}
	constructor(judge: Judge, model: Model | undefined) {
		this.#judge = judge;
		this.#model = model;
		let dispatch = judgeDispatch.get(judge);
		if (!dispatch) {
			dispatch = { ready: Promise.resolve(), lastStart: Number.NEGATIVE_INFINITY };
			judgeDispatch.set(judge, dispatch);
		}
		this.#dispatch = dispatch;
	}

	/** Count one response; an unbilled one is priced at its catalog model's rates. */
	record(result: JudgmentResult): void {
		const judge = this.#judge;
		this.usage.tokens += result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
		if (result.usage.cost.total > 0) {
			this.usage.costUsd += result.usage.cost.total;
			return;
		}
		const model =
			this.#model ??
			catalogModel(result.provider, result.model) ??
			(judge instanceof TypeSafeJudge ? catalogModel(judge.provider, judge.model) : undefined);
		if (model) this.usage.costUsd += calculateCost(model, { ...result.usage, cost: { ...result.usage.cost } }).total;
	}

	finish(): ClmArchiveJudgeUsage {
		this.usage.ms = performance.now() - this.#started;
		return this.usage;
	}
}

/**
 * One noul per passage, packed into requests under Jev's state budget; returns p per id.
 * Any failure, including a missing or out-of-range answer, rejects.
 */
async function judgePassages(
	judge: Judge,
	meter: JudgeMeter,
	query: string,
	passages: Iterable<readonly [string, string]>,
	template: string,
	criteria: { no: string; yes: string },
	questionsPerRequest: number,
	signal: AbortSignal,
	tokenBudget = Number.POSITIVE_INFINITY,
): Promise<Map<string, number>> {
	const batches: {
		passages: Record<string, string>;
		questions: Record<string, NoulQuestion>;
		tokens: number;
		questionTokens: number;
		largestQuestion: number;
	}[] = [];
	const state = { criteria, passages: {} as Record<string, string>, search: query };
	let spent = 0;
	const expected = new Set<string>();
	for (const [id, text] of passages) {
		signal.throwIfAborted();
		const question: NoulQuestion = { type: "noul", instructions: prompt.render(template, { key: id }).trim() };
		const questionTokens = countTokens(JSON.stringify(question), Encoding.Jev);
		let batch = batches.at(-1);
		let fresh = !batch || Object.keys(batch.questions).length >= questionsPerRequest;
		if (!batch || fresh) batch = { passages: {}, questions: {}, tokens: 0, questionTokens: 0, largestQuestion: 0 };
		batch.passages[id] = text;
		state.passages = batch.passages;
		let stateTokens = countTokens(JSON.stringify(state), Encoding.Jev);
		if (stateTokens + Math.max(batch.largestQuestion, questionTokens) > REQUEST_STATE_TOKENS) {
			delete batch.passages[id];
			batch = { passages: { [id]: text }, questions: {}, tokens: 0, questionTokens: 0, largestQuestion: 0 };
			state.passages = batch.passages;
			stateTokens = countTokens(JSON.stringify(state), Encoding.Jev);
			if (stateTokens + questionTokens > REQUEST_STATE_TOKENS)
				throw new Error("archive search query and passage exceed Jev judgment token budget");
			fresh = true;
		}
		// Shared state is billed once per request; every question is billed. Reserve transport framing too.
		const tokens = stateTokens + batch.questionTokens + questionTokens + 512;
		if (spent - batch.tokens + tokens > tokenBudget) {
			delete batch.passages[id];
			break;
		}
		spent += tokens - batch.tokens;
		batch.tokens = tokens;
		batch.questionTokens += questionTokens;
		batch.largestQuestion = Math.max(batch.largestQuestion, questionTokens);
		batch.questions[id] = question;
		if (fresh) batches.push(batch);
		expected.add(id);
	}
	const probabilities = new Map<string, number>();
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(MAX_IN_FLIGHT, batches.length) }, async () => {
			while (next < batches.length) {
				const batch = batches[next++];
				await meter.start(signal);
				let result: JudgmentResult;
				try {
					result = await judge.judge(
						{ state: { criteria, passages: batch.passages, search: query }, questions: batch.questions },
						{ signal },
					);
				} finally {
					meter.release();
				}
				meter.record(result);
				signal.throwIfAborted();
				for (const id of Object.keys(batch.questions)) {
					const answer = result.answers[id];
					const p = answer?.type === "noul" ? answer.noul : Number.NaN;
					if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`judge returned no probability for ${id}`);
					probabilities.set(id, p);
				}
			}
		}),
	);
	for (const id of expected) if (!probabilities.has(id)) throw new Error(`judge returned no answer for ${id}`);
	return probabilities;
}

interface JevRanking {
	candidates: Hit[];
	scanned: number;
	scanTotal?: number;
}

/**
 * Rerank `shortlist` (plus the superseders of its stale items) on full passages while scanning
 * compact views of every other item, newest first, then rerank the best scan finds on full
 * passages too. Sets `probability` on every returned candidate.
 */
async function jevRanking(
	archive: ClmArchive,
	judge: Judge,
	meter: JudgeMeter,
	query: string,
	shortlist: readonly Hit[],
	lines: LineMatcher,
	signal: AbortSignal,
): Promise<JevRanking> {
	const candidates = [...shortlist];
	const seen = new Set(candidates.map(hit => hit.item.id));
	for (const hit of shortlist) {
		let superseder = hit.item;
		const chain = new Set([superseder.id]);
		while (superseder.supersededBy) {
			const next = archive.get(superseder.supersededBy);
			if (!next || chain.has(next.id)) break;
			chain.add(next.id);
			superseder = next;
		}
		if (superseder && !seen.has(superseder.id)) {
			seen.add(superseder.id);
			candidates.push({ item: superseder, lexical: 0, origin: "superseder" });
		}
	}
	const rerank = async (hits: readonly Hit[]) => {
		const passages = new Map(hits.map(hit => [hit.item.id, passage(archive, hit.item, lines)]));
		const probabilities = await judgePassages(
			judge,
			meter,
			query,
			passages,
			recallQuestionTemplate,
			RECALL_CRITERIA,
			QUESTIONS_PER_REQUEST,
			signal,
		);
		for (const hit of hits) hit.probability = probabilities.get(hit.item.id);
	};
	const scanTotal = archive.items.length - seen.size;
	function* views(): Iterable<readonly [string, string]> {
		for (let i = archive.items.length - 1; i >= 0; i--) {
			signal.throwIfAborted();
			const item = archive.items[i];
			if (!seen.has(item.id)) yield [item.id, scanView(archive, item)];
		}
	}
	// A confident lexical distractor says nothing about paraphrased evidence elsewhere: always scan.
	const [, scanned] = await Promise.all([
		candidates.length > 0 ? rerank(candidates) : undefined,
		judgePassages(
			judge,
			meter,
			query,
			views(),
			scanQuestionTemplate,
			SCAN_CRITERIA,
			SCAN_QUESTIONS_PER_REQUEST,
			signal,
			SCAN_TOKENS,
		),
	]);
	const finds: Hit[] = [...scanned]
		.filter(([, p]) => p >= SCAN_MIN_P)
		.sort((a, b) => b[1] - a[1])
		.slice(0, SCAN_KEEP)
		.map(([id, p]) => ({ item: archive.get(id)!, lexical: p, origin: "scan" }));
	if (finds.length > 0) await rerank(finds);
	return { candidates: [...candidates, ...finds], scanned: scanned.size, scanTotal };
}

const toCandidate = (hit: Hit): ClmArchiveCandidate => ({
	id: hit.item.id,
	...(hit.lexicalRank === undefined ? {} : { lexicalRank: hit.lexicalRank }),
	score: hit.lexical,
	origin: hit.origin,
	...(hit.probability === undefined ? {} : { p: hit.probability }),
});

const toHit = (hit: Hit): ClmArchiveSearchHit => ({
	item: hit.item,
	...(hit.lexicalRank === undefined ? {} : { lexicalRank: hit.lexicalRank }),
	...(hit.probability === undefined ? {} : { p: hit.probability }),
	origin: hit.origin,
});

interface Ranked {
	result: ClmArchiveSearchResult;
	lines: LineMatcher;
}

async function rank(archive: ClmArchive, options: ClmArchiveSearchOptions): Promise<Ranked> {
	options.signal?.throwIfAborted();
	const limit = Math.min(CLM_ARCHIVE_SEARCH_MAX_LIMIT, Math.max(1, options.limit ?? CLM_ARCHIVE_SEARCH_LIMIT));
	const query = options.query.trim();
	if (query === "") throw new Error("Archive search needs a non-empty q");

	if (options.regex) {
		let scan: { matches: number[]; positions: Map<string, number> };
		try {
			scan = regexScan.runInNewContext({ query, items: archive.items, limit }, { timeout: REGEX_TIMEOUT_MS });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`${/timed out/i.test(message) ? "Archive regex timed out" : "Invalid archive regex"}: ${message}`,
			);
		}
		options.signal?.throwIfAborted();
		const hits = scan.matches
			.slice(-limit)
			.reverse()
			.map(index => ({ item: archive.items[index] }));
		return {
			result: { query, mode: "regex", matches: scan.matches.length, shortlist: [], hits },
			lines: {
				score: line => ((scan.positions.get(line) ?? -1) >= 0 ? 1 : 0),
				focus: line => scan.positions.get(line) ?? -1,
			},
		};
	}

	const allTerms = [...new Set(archiveTerms(query))];
	const contentTerms = allTerms.filter(term => !Object.hasOwn(STOPWORDS, term));
	const queryTerms = contentTerms.length > 0 ? contentTerms : allTerms;
	if (queryTerms.length === 0) throw new Error("Archive query has no searchable terms; use &regex=1 for symbols");
	const lines: LineMatcher = {
		score: termLineScore(queryTerms),
		terms: queryTerms,
		focus: line => {
			const normalized = line.normalize("NFC");
			const lower = normalized.toLowerCase();
			let position = Number.POSITIVE_INFINITY;
			for (const term of queryTerms) {
				const at = lower.indexOf(term);
				if (at >= 0) position = Math.min(position, at);
			}
			if (!Number.isFinite(position)) return 0;
			if (normalized === line && lower.length === line.length) return position;
			// Excerpts slice verbatim text: translate the normalized offset back to its source offset.
			let start = 0;
			let end = line.length;
			while (start < end) {
				const middle = Math.floor((start + end) / 2);
				if (line.slice(0, middle).normalize("NFC").toLowerCase().length < position) start = middle + 1;
				else end = middle;
			}
			return start;
		},
	};
	const matches = bm25(archive, queryTerms);
	const shortlist = matches.slice(0, CLM_ARCHIVE_SHORTLIST);
	const lexical = (fallbackReason: string): Ranked => ({
		result: {
			query,
			mode: "lexical",
			fallbackReason,
			matches: matches.length,
			shortlist: shortlist.map(toCandidate),
			hits: supersessionOrder(archive, shortlist).slice(0, limit).map(toHit),
		},
		lines,
	});
	if (options.rerank === false) return lexical("rerank disabled by request");
	if (!options.judge)
		return lexical(`no rerank: ${options.judgeUnavailable ?? "no native judge (TypeSafe Jev) configured"}`);

	const judge = options.judge;
	const meter = new JudgeMeter(judge, options.judgeModel);
	const controller = new AbortController();
	const signals = [controller.signal, AbortSignal.timeout(options.timeoutMs ?? RERANK_TIMEOUT_MS)];
	if (options.signal) signals.push(options.signal);
	let ranking: JevRanking;
	try {
		const signal = AbortSignal.any(signals);
		ranking = await untilAborted(signal, () => jevRanking(archive, judge, meter, query, shortlist, lines, signal));
		options.signal?.throwIfAborted();
	} catch (error) {
		controller.abort(error);
		options.signal?.throwIfAborted();
		for (const hit of shortlist) hit.probability = undefined;
		const fallback = lexical(`Jev rerank failed open: ${error instanceof Error ? error.message : String(error)}`);
		fallback.result.judge = meter.finish();
		return fallback;
	}
	const relevant = supersessionOrder(
		archive,
		ranking.candidates
			.filter(hit => (hit.probability ?? 0) >= CLM_ARCHIVE_RERANK_THRESHOLD)
			.sort(
				(a, b) =>
					(b.probability ?? 0) - (a.probability ?? 0) ||
					(a.lexicalRank ?? Number.POSITIVE_INFINITY) - (b.lexicalRank ?? Number.POSITIVE_INFINITY) ||
					b.item.timestamp - a.item.timestamp,
			),
	);
	return {
		result: {
			query,
			mode: "jev",
			matches: matches.length,
			shortlist: ranking.candidates.map(toCandidate),
			hits: (relevant.length > 0 ? relevant : supersessionOrder(archive, shortlist)).slice(0, limit).map(toHit),
			relevant: relevant.length,
			scanned: ranking.scanned,
			...(ranking.scanTotal === undefined ? {} : { scanTotal: ranking.scanTotal }),
			judge: meter.finish(),
		},
		lines,
	};
}

/** Rank one archive search as data: mode, candidates, best-first hits, and judge usage. */
export async function rankClmArchive(
	archive: ClmArchive,
	options: ClmArchiveSearchOptions,
): Promise<ClmArchiveSearchResult> {
	return (await rank(archive, options)).result;
}

function renderHits(hits: readonly ClmArchiveSearchHit[], header: string, route: string, lines: LineMatcher): string {
	const out = [header, `# Expand: ${route}/<id> (verbatim) or ${route}/<id>:N-M; L<n> below are item line numbers.`];
	const best = hits[0];
	for (const hit of [...hits].sort((a, b) => a.item.timestamp - b.item.timestamp)) {
		const tags: string[] = [];
		if (hit.p !== undefined) tags.push(`relevance p=${hit.p.toFixed(2)}`);
		if (hit.lexicalRank !== undefined) tags.push(`lexical #${hit.lexicalRank}`);
		else if (hit.origin === "scan") tags.push("label scan");
		else if (hit.origin === "superseder") tags.push("supersedes a match");
		const suffix = tags.length > 0 ? ` {${tags.join(", ")}}` : "";
		if (hit === best && hit.item.tokens <= WHOLE_BEST_HIT_TOKENS) {
			out.push(
				`${renderArchiveManifestLine(hit.item)}${suffix} (whole item)`,
				...hit.item.text.split("\n").map((line, index) => `  L${index + 1}: ${line}`),
			);
			continue;
		}
		const shown = excerpt(hit.item.text, lines);
		out.push(`${renderArchiveManifestLine(hit.item)}${suffix}`, ...shown.lines);
		if (shown.partial)
			out.push(
				`  (excerpt: ${shown.lines.length} of ${shown.total} lines — read ${route}/${hit.item.id} before answering exact questions)`,
			);
	}
	return out.join("\n");
}

function renderSearch(result: ClmArchiveSearchResult, total: number, route: string, lines: LineMatcher): string {
	const { query, hits } = result;
	if (result.mode === "regex") {
		if (hits.length === 0) return `# Archive regex /${query}/i: no matching items among ${total}.`;
		return renderHits(
			hits,
			`# Archive regex /${query}/i: ${result.matches} matching items of ${total}; newest ${hits.length} shown chronologically (exact filter, no rerank).`,
			route,
			lines,
		);
	}
	const lexicalCount = result.shortlist.filter(candidate => candidate.origin === "lexical").length;
	const scanCoverage =
		result.scanTotal !== undefined && (result.scanned ?? 0) < result.scanTotal
			? ` (newest ${result.scanned ?? 0} of ${result.scanTotal}; truncated at scan token budget)`
			: "";
	const usage = result.judge
		? `${result.judge.requests} requests, ${result.judge.tokens} tokens, $${result.judge.costUsd.toFixed(4)}, ${(result.judge.ms / 1000).toFixed(1)}s`
		: "";
	if (hits.length === 0 && result.matches === 0) {
		const scanned =
			result.scanTotal !== undefined
				? ` Jev label scan of ${result.scanned ?? 0} items${scanCoverage} found nothing relevant.`
				: "";
		const status = result.mode === "lexical" ? ` Lexical order only (${result.fallbackReason}).` : "";
		return `# Archive search "${query}": no lexical matches among ${total} items.${scanned}${status}${usage ? ` Judge usage (${usage}).` : ""} Try other identifiers, a path fragment, or &regex=1.`;
	}
	let stage1 = `BM25 shortlist ${lexicalCount} of ${result.matches} matching items (of ${total})`;
	const pulled =
		result.shortlist.length - lexicalCount - result.shortlist.filter(candidate => candidate.origin === "scan").length;
	if (pulled > 0) stage1 += ` + ${pulled} superseding items`;
	if (result.scanTotal !== undefined) stage1 += ` + Jev label scan of ${result.scanned ?? 0} more${scanCoverage}`;
	if (result.mode === "lexical") {
		return renderHits(
			hits,
			`# Archive search "${query}": ${stage1}; lexical order only (${result.fallbackReason}).${usage ? ` Judge usage (${usage}).` : ""} Top ${hits.length} by BM25 shown chronologically.`,
			route,
			lines,
		);
	}
	if (!result.relevant) {
		const best = Math.max(0, ...result.shortlist.map(candidate => candidate.p ?? 0));
		return renderHits(
			hits,
			`# Archive search "${query}": ${stage1} → Jev rerank (${usage}) judged none relevant (max p=${best.toFixed(2)} < ${CLM_ARCHIVE_RERANK_THRESHOLD}). Lexical top ${hits.length} shown chronologically as weak evidence.`,
			route,
			lines,
		);
	}
	return renderHits(
		hits,
		`# Archive search "${query}": ${stage1} → Jev rerank (${usage}); ${result.relevant} items at p ≥ ${CLM_ARCHIVE_RERANK_THRESHOLD}, best ${hits.length} by relevance shown chronologically.`,
		route,
		lines,
	);
}

/**
 * Run one archive search: the model-facing text (inline, chronological hits with stable ids) and
 * the same ranking as transcript data (best first, with each hit's first excerpt line).
 */
export async function searchClmArchive(
	archive: ClmArchive,
	options: ClmArchiveSearchOptions,
): Promise<{ text: string; details: ClmArchiveSearchReadDetails }> {
	const { result, lines } = await rank(archive, options);
	const total = archive.items.length;
	const lexical = result.shortlist.filter(candidate => candidate.origin === "lexical").length;
	const scan = result.shortlist.filter(candidate => candidate.origin === "scan").length;
	return {
		text: renderSearch(result, total, options.routePrefix ?? CLM_ARCHIVE_ROUTE, lines),
		details: {
			kind: "archive-search",
			query: result.query,
			mode: result.mode,
			...(result.fallbackReason === undefined ? {} : { fallbackReason: result.fallbackReason }),
			total,
			matches: result.matches,
			shortlist: lexical,
			superseders: result.shortlist.length - lexical - scan,
			...(result.scanTotal === undefined ? {} : { scanned: result.scanned ?? 0, scanTotal: result.scanTotal }),
			...(result.relevant === undefined ? {} : { relevant: result.relevant }),
			threshold: CLM_ARCHIVE_RERANK_THRESHOLD,
			...(result.judge ? { judge: result.judge } : {}),
			hits: result.hits.map(hit => {
				const first = excerpt(hit.item.text, lines).first;
				return {
					...clmArchiveRow(hit.item),
					...(hit.p === undefined ? {} : { p: hit.p }),
					...(hit.lexicalRank === undefined ? {} : { lexicalRank: hit.lexicalRank }),
					...(hit.origin === undefined ? {} : { origin: hit.origin }),
					preview: first ? clmPreview(first.text) : "",
					...(first ? { line: first.line } : {}),
				};
			}),
		},
	};
}
