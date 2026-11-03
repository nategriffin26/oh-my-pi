import { beforeAll, describe, expect, it } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge, JudgmentRequest, JudgmentResult, Message, Questions } from "@oh-my-pi/pi-ai";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";
import { Settings } from "../src/config/settings";
import { ClmContext } from "../src/session/clm-context";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { ReadTool } from "../src/tools/read";
import { spillToolResultToArtifact } from "../src/tools/output-meta";

interface Envelope {
	revision: string;
	snapshotId: string;
	/** As read: every block is host-issued, so `id` and `role` are always present. */
	blocks: Array<{ id: string; role: string; text: string; protected?: boolean; opaque?: boolean }>;
}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "m",
		stopReason: "stop",
		timestamp,
		content,
		usage,
	};
}

/** Scores passages by keyword so a judged ranking differs from the lexical one. */
const judge: Judge = {
	label: "stub",
	async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		const state = request.state as { passages?: Record<string, string> };
		const answers = Object.fromEntries(
			Object.keys(request.questions).map(id => {
				const passage = String(state.passages?.[id] ?? "");
				return [
					id,
					{ type: "noul", noul: passage.includes("250ms") ? 0.9 : passage.includes("flush") ? 0.6 : 0.05 },
				];
			}),
		);
		const result = { api: "stub", provider: "stub", model: "stub", answers, usage };
		return result as unknown as JudgmentResult<Q>;
	},
};

function harness(recall: () => Judge | string | undefined) {
	const history: Message[] = [
		{ role: "developer", content: "KEEP_HOST_CONSTRAINT", timestamp: 0 },
		{ role: "user", content: "The flake shows under --parallel; keep the 250ms flush window.", timestamp: 1 },
		assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/batcher.ts" } }], 2),
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "flush() { /* window */ }" }],
			isError: false,
			timestamp: 3,
		},
		assistant([{ type: "text", text: "shutdown() resolves before the in-flight flush settles." }], 4),
		{ role: "user", content: "Check what I said about the flush window.", timestamp: 5 },
		assistant([{ type: "text", text: "LIVE_COMPLETED_EXCHANGE" }], 6),
	];
	let messages: AgentMessage[] = history;
	const manager = SessionManager.inMemory("/clm-read-details");
	for (const message of history) manager.appendMessage(message);
	const tokenizer = new Tokenizer();
	const model = { contextWindow: 200_000 } as never;
	const clm = new ClmContext({
		manager,
		enabled: () => true,
		epoch: () => "read-details",
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
		recallJudge: recall,
	});
	return { clm, manager, messages: () => messages };
}

async function readEnvelope(clm: ClmContext) {
	const result = await clm.read({ kind: "document" });
	const envelope = JSON.parse(result.text) as Envelope;
	if (result.details.kind !== "document") throw new Error(`unexpected details kind ${result.details.kind}`);
	return { envelope, details: result.details };
}

/** Hit facts as the model reads them: one `h… <time> …` header line per hit, annotated `{relevance p=…, lexical #…}`. */
function modelHits(text: string): Record<string, { p?: number; rank?: number }> {
	const hits: Record<string, { p?: number; rank?: number }> = {};
	for (const line of text.split("\n")) {
		const id = /^(h[0-9a-f]{10}) \d{4}-/.exec(line)?.[1];
		if (!id) continue;
		const p = /p=([\d.]+)/.exec(line)?.[1];
		const rank = /lexical #(\d+)/.exec(line)?.[1];
		hits[id] = { p: p === undefined ? undefined : Number(p), rank: rank === undefined ? undefined : Number(rank) };
	}
	return hits;
}

describe("CLM read details", () => {
	it("describe the blocks the model reads, including after a committed edit", async () => {
		const h = harness(() => undefined);
		const first = await readEnvelope(h.clm);
		expect(first.details.revision).toBe(first.envelope.revision);
		expect(first.details.snapshotId).toBe(first.envelope.snapshotId);
		expect(first.details.blocks.map(block => [block.id, block.role, !!block.protected, !!block.opaque])).toEqual(
			first.envelope.blocks.map(block => [block.id, block.role, !!block.protected, !!block.opaque]),
		);

		const removed = first.envelope.blocks.find(block => !block.protected && block.text.includes("in-flight"));
		expect(removed).toBeDefined();
		first.envelope.blocks = first.envelope.blocks.filter(block => block !== removed);
		await h.clm.stage(JSON.stringify(first.envelope), "tx");
		await h.clm.commitBoundary(h.messages());

		const second = await readEnvelope(h.clm);
		expect(second.details.revision).not.toBe(first.details.revision);
		expect(second.details.revision).toBe(second.envelope.revision);
		expect(second.details.blocks.map(block => block.id)).toEqual(second.envelope.blocks.map(block => block.id));
		expect(second.details.blocks.some(block => block.preview.includes("in-flight"))).toBe(false);
	});

	it.each([1000, 4000])("persists only visible previews when paging %i blocks", async count => {
		const h = harness(() => undefined);
		for (let index = 0; index < count; index++) {
			const message: Message = { role: "user", content: "UNREQUESTED_PREVIEW_" + index, timestamp: 100 + index };
			h.messages().push(message);
			h.manager.appendMessage(message);
		}
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => h.manager.getSessionId(),
			sessionManager: h.manager,
			clmContext: h.clm,
		};
		const full = await readEnvelope(h.clm);
		const read = new ReadTool(session);
		const header = await read.execute("header", { path: "context://self:raw:1-1" });
		const serialized = JSON.stringify(header.details?.clm);
		console.log(count, "added blocks: header CLM metadata", Buffer.byteLength(serialized), "bytes");
		expect(serialized).not.toContain("UNREQUESTED_PREVIEW");
		expect(Buffer.byteLength(serialized)).toBeLessThan(512);
		expect(header.details?.clm).toMatchObject({ blockCount: full.envelope.blocks.length, blocks: [] });
		const row = await read.execute("row", { path: "context://self:raw:2-2" });
		if (row.details?.clm?.kind !== "document") throw new Error("expected document rows");
		expect(row.details.clm.blocks.map(block => block.id)).toEqual([full.envelope.blocks[0].id]);
		expect(row.details.clm.blockCount).toBe(full.envelope.blocks.length);
		expect(row.details.clm.blocks[0].line).toBe(2);
		expect(JSON.stringify(row.details.clm)).not.toContain("UNREQUESTED_PREVIEW");
		const fullAgain = await read.execute("full", { path: "context://self:raw" });
		if (fullAgain.details?.clm?.kind !== "document") throw new Error("expected full document");
		expect(fullAgain.details.clm.blocks.map(block => block.id)).toEqual(full.envelope.blocks.map(block => block.id));
	});

	it("carry the model's hits, probabilities only when judged, ranked best first", async () => {
		const query = { kind: "archive-search", query: "flush window", regex: false, rerank: true } as const;
		const judged = await harness(() => judge).clm.read(query);
		if (judged.details.kind !== "archive-search") throw new Error("expected search details");
		expect(judged.details.mode).toBe("jev");
		expect(judged.details.hits.length).toBeGreaterThan(1);
		const judgedText = modelHits(judged.text);
		expect(judged.details.hits.map(hit => hit.id).sort()).toEqual(Object.keys(judgedText).sort());
		for (const hit of judged.details.hits) {
			expect(hit.p).toBeDefined();
			expect(hit.p?.toFixed(2)).toBe(judgedText[hit.id].p?.toFixed(2));
			expect(hit.lexicalRank).toBe(judgedText[hit.id].rank);
		}
		const probabilities = judged.details.hits.map(hit => hit.p ?? -1);
		expect(probabilities).toEqual([...probabilities].sort((a, b) => b - a));
		expect(probabilities[0]).toBe(0.9);

		const reason = "the user chose lexical recall";
		const lexical = await harness(() => reason).clm.read(query);
		if (lexical.details.kind !== "archive-search") throw new Error("expected search details");
		expect(lexical.details.mode).toBe("lexical");
		expect(lexical.details.fallbackReason).toContain(reason);
		const lexicalText = modelHits(lexical.text);
		expect(lexical.details.hits.map(hit => hit.id).sort()).toEqual(Object.keys(lexicalText).sort());
		expect(lexical.details.hits.every(hit => hit.p === undefined)).toBe(true);

		const regex = await harness(() => judge).clm.read({ ...query, query: "flush", regex: true });
		if (regex.details.kind !== "archive-search") throw new Error("expected search details");
		expect(regex.details.mode).toBe("regex");
		expect(regex.details.hits.length).toBe(Object.keys(modelHits(regex.text)).length);
		expect(regex.details.hits.every(hit => hit.p === undefined)).toBe(true);
	});

	describe("rendered read", () => {
		beforeAll(async () => {
			await initTheme(false, undefined, undefined, "dark", "light");
		});

		it("shows only the paged blocks and renders identically from persisted details", async () => {
			const h = harness(() => undefined);
			const session: ToolSession = {
				cwd: "/tmp",
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getSessionId: () => h.manager.getSessionId(),
				sessionManager: h.manager,
				clmContext: h.clm,
			};
			const { envelope } = await readEnvelope(h.clm);
			// Envelope line 1 is the head; line i + 2 is block i, so lines 3-4 are blocks 1 and 2.
			const path = "context://self:raw:3-4";
			const live = await new ReadTool(session).execute("r", { path });
			const theme = await getThemeByName("dark");
			if (!theme) throw new Error("dark theme missing");
			// Render the live result and its JSON round trip (what a resumed session reloads).
			const [lines, reloaded] = [live, JSON.parse(JSON.stringify(live))].map(result =>
				readToolRenderer
					.renderResult(result, { expanded: true, isPartial: false }, theme, { path })
					.render(100)
					.map(line => Bun.stripANSI(line)),
			);
			const rowIds = lines.flatMap(line => /^│ (b\d+)\s/.exec(line)?.[1] ?? []);
			expect(rowIds).toEqual([envelope.blocks[1].id, envelope.blocks[2].id]);
			expect(reloaded).toEqual(lines);
		});
		it("maps disjoint raw page lines without inventing intervening blocks", async () => {
			const h = harness(() => undefined);
			const session: ToolSession = {
				cwd: "/tmp",
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getSessionId: () => h.manager.getSessionId(),
				sessionManager: h.manager,
				clmContext: h.clm,
			};
			const { envelope } = await readEnvelope(h.clm);
			const path = "context://self:raw:2-2,5-5";
			const result = await new ReadTool(session).execute("r", { path });
			const theme = await getThemeByName("dark");
			if (!theme) throw new Error("dark theme missing");
			const rendered = readToolRenderer
				.renderResult(result, { expanded: true, isPartial: false }, theme, { path })
				.render(100)
				.map(line => Bun.stripANSI(line));
			expect(rendered.flatMap(line => /^│ (b\d+)\s/.exec(line)?.[1] ?? [])).toEqual([
				envelope.blocks[0].id,
				envelope.blocks[3].id,
			]);
		});

		it("keeps the full-output artifact pointer visible after a CLM read spills", async () => {
			const h = harness(() => undefined);
			const session: ToolSession = {
				cwd: "/tmp",
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getSessionId: () => h.manager.getSessionId(),
				sessionManager: h.manager,
				clmContext: h.clm,
			};
			const path = "context://self:raw";
			const result = await new ReadTool(session).execute("r", { path });
			const spilled = await spillToolResultToArtifact(result, "read", h.manager, {
				threshold: 64,
				headBytes: 20,
				tailBytes: 20,
				tailLines: 2,
			});
			const theme = await getThemeByName("dark");
			if (!theme) throw new Error("dark theme missing");
			const rendered = readToolRenderer
				.renderResult(spilled, { expanded: false, isPartial: false }, theme, { path })
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("artifact://");
		});

		it.each([
			["context://self:raw:999-999", "Line 999 is beyond end of resource"],
			["context://self:raw:3-3,999-999", "Range 999-999 is beyond end of resource"],
		])("keeps beyond-end diagnostics visible for %s", async (path, diagnostic) => {
			const h = harness(() => undefined);
			const session: ToolSession = {
				cwd: "/tmp",
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				getSessionId: () => h.manager.getSessionId(),
				sessionManager: h.manager,
				clmContext: h.clm,
			};
			await readEnvelope(h.clm);
			const result = await new ReadTool(session).execute("r", { path });
			const theme = await getThemeByName("dark");
			if (!theme) throw new Error("dark theme missing");
			const rendered = readToolRenderer
				.renderResult(result, { expanded: true, isPartial: false }, theme, { path })
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain(diagnostic);
			expect(rendered).not.toContain("KEEP_HOST_CONSTRAINT");
		});
	});
});
