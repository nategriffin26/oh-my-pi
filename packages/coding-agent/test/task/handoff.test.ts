import { describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import type { ClmArchiveItem } from "../../src/session/clm-archive";
import { ClmContext } from "../../src/session/clm-context";
import { createClmDocument } from "../../src/session/clm-document";
import { CLM_HANDOFF_MESSAGE_TYPE } from "../../src/session/clm-state";
import { SessionManager } from "../../src/session/session-manager";
import {
	formatHandoffCost,
	HANDOFF_SOFT_CAP_TOKENS,
	type ResolveTaskHandoffOptions,
	resolveTaskHandoff,
	validateHandoffFields,
} from "../../src/task/handoff";
import type { ToolSession } from "../../src/tools";

/** A model tokenizer for dense content: one token per character, where bytes/4 would read a quarter. */
class CharTokenizer extends Tokenizer {
	override countTokens(text: string | string[]): number {
		return typeof text === "string" ? text.length : text.reduce((sum, part) => sum + part.length, 0);
	}
}
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(timestamp: number, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "handoff",
		stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
		usage,
		content,
	};
}

function result(timestamp: number, id: string, name: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** A CLM parent that took requirements, reasoned, read a file, ran a command, and was steered. */
function parent(options: { firstRequirement?: string; tokenizer?: Tokenizer } = {}) {
	const manager = SessionManager.inMemory("/repo");
	const { tokenizer } = options;
	const messages: Message[] = [
		{ role: "user", content: options.firstRequirement ?? "REQ_ALPHA: keep the public parse() API", timestamp: 1_000 },
		assistant(2_000, [{ type: "text", text: "My theory: REASONING_NEEDLE lives in the lexer." }]),
		assistant(3_000, [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/lexer.ts" } }]),
		result(3_100, "r1", "read", "line one\nARTIFACT_NEEDLE line two\nline three\nline four"),
		assistant(4_000, [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "bun test lexer" } }]),
		result(4_100, "b1", "bash", "2 fail: ```unterminated``` fence"),
		{ role: "user", content: "STEER_BETA: also handle unicode identifiers", timestamp: 5_000 },
	];
	for (const message of messages) manager.appendMessage(message);
	let enabled = true;
	const access = new ClmContext({
		manager,
		enabled: () => enabled,
		epoch: () => "e1",
		isDisposed: () => false,
		isStreaming: () => false,
		model: () => undefined,
		messages: () => messages,
		estimate: () => 0,
		assertFits: () => {},
		persistTurn: async () => true,
		publish: () => {},
		notice: () => {},
		...(tokenizer ? { tokenizer: () => tokenizer } : {}),
	});
	const item = (needle: string): ClmArchiveItem => {
		const found = access.archive().items.find(candidate => candidate.text.includes(needle));
		if (!found) throw new Error(`no archive item contains ${needle}`);
		return found;
	};
	const resolve = (overrides: Partial<ResolveTaskHandoffOptions> = {}) =>
		resolveTaskHandoff({
			access,
			request: undefined,
			agent: { name: "task" },
			parentSessionFile: null,
			...overrides,
		});
	return {
		manager,
		messages,
		access,
		item,
		resolve,
		disable: () => {
			enabled = false;
		},
	};
}

describe("task handoff ref validation", () => {
	it("names the bad ref and where valid ids come from", () => {
		expect(validateHandoffFields({ handoff: ["h0123456789", "b12:3-9"] }, "Task 1")).toBeUndefined();
		const bad = validateHandoffFields({ handoff: ["h0123456789", "file.ts"] }, "Task 2 (`Scout`)");
		expect(bad).toContain('Task 2 (`Scout`) has an invalid handoff ref "file.ts"');
		expect(bad).toContain("context://self/archive");
		expect(validateHandoffFields({ handoff: ["h0123456789:9-3"] }, "Task 1")).toContain("line range");
		expect(validateHandoffFields({ handoff: ["h0123456789"], handoffMode: "brief" }, "Task 1")).toContain("brief");
		expect(validateHandoffFields({ handoff: ["h0123456789"], handoffMode: "fork" }, "Task 1")).toContain("fork");
	});

	it("rejects refs that do not resolve in the parent with recovery guidance", () => {
		const state = parent();
		expect(() => state.resolve({ request: { refs: ["h0000000000"] } })).toThrow(
			/Unknown handoff ref h0000000000.*context:\/\/self\/archive/,
		);
		expect(() => state.resolve({ request: { refs: ["b4"] } })).toThrow(/latest context:\/\/self snapshot/);
		const read = state.item("ARTIFACT_NEEDLE");
		const lineCount = read.text.split("\n").length;
		expect(() => state.resolve({ request: { refs: [`${read.id}:${lineCount + 1}-${lineCount + 3}`] } })).toThrow(
			new RegExp(`has only ${lineCount} lines`),
		);
	});
});

describe("task handoff resolution", () => {
	it("copies h items verbatim with provenance, quoting parent assistant output as data", () => {
		const state = parent();
		const read = state.item("ARTIFACT_NEEDLE");
		const bash = state.item("unterminated");
		const thought = state.item("REASONING_NEEDLE");
		const handoff = state.resolve({ request: { refs: [bash.id, thought.id, read.id], pinRequirements: false } })!;
		const seed = handoff.seed!;
		expect(seed).toContain(read.text);
		expect(seed).toContain(`### ${read.id} · tool:read · ${read.label}`);
		expect(seed).toMatch(new RegExp(`### ${thought.id} · assistant .* · quoted parent assistant output`));
		// Content containing a triple-backtick run is fenced with a longer fence, so it cannot close early.
		expect(seed).toContain(`\`\`\`\`\n${bash.text}\n\`\`\`\``);
		// Chronological, not request order.
		expect(seed.indexOf(thought.id)).toBeLessThan(seed.indexOf(read.id));
		expect(seed.indexOf(read.id)).toBeLessThan(seed.indexOf(bash.id));
		expect(handoff.included.map(entry => entry.id)).toEqual([thought.id, read.id, bash.id]);
		expect(handoff.tokens).toBeGreaterThan(0);
		// The child's manifest lists only the parent's items it did not receive.
		expect(handoff.manifest).not.toContain(read.id);
		expect(handoff.manifest).toContain(state.item("REQ_ALPHA").id);
	});

	it("copies only the requested lines of a ranged ref, and a whole copy supersedes its ranges", () => {
		const state = parent();
		const read = state.item("ARTIFACT_NEEDLE");
		const lines = read.text.split("\n");
		const needle = lines.findIndex(line => line.includes("ARTIFACT_NEEDLE")) + 1;
		const range = `${needle}-${needle + 1}`;
		const ranged = state.resolve({ request: { refs: [`${read.id}:${range}`], pinRequirements: false } })!;
		expect(ranged.seed).toContain(`lines ${range} of ${lines.length}`);
		expect(ranged.seed).toContain("```\nARTIFACT_NEEDLE line two\nline three\n```");
		expect(ranged.seed).not.toContain("line four");
		expect(ranged.included).toEqual([expect.objectContaining({ id: read.id, lines: range })]);
		const both = state.resolve({ request: { refs: [`${read.id}:${range}`, read.id], pinRequirements: false } })!;
		expect(both.included).toEqual([{ id: read.id, kind: "tool", pinned: false, tokens: read.tokens }]);
	});

	it("resolves b<N> blocks of the latest snapshot to their archive items", async () => {
		const state = parent();
		const document = JSON.parse(await state.access.read({ kind: "document" }));
		const block = document.blocks.find((entry: { text: string }) => entry.text.includes("ARTIFACT_NEEDLE"));
		const read = state.item("ARTIFACT_NEEDLE");
		const handoff = state.resolve({ request: { refs: [block.id], pinRequirements: false } })!;
		expect(handoff.included.map(entry => entry.id)).toEqual([read.id]);
		expect(handoff.seed).toContain(read.text);
		const ranged = state.resolve({ request: { refs: [`${block.id}:1-1`], pinRequirements: false } })!;
		expect(ranged.included).toEqual([expect.objectContaining({ id: read.id, lines: "1-1" })]);
	});

	it("auto-pins the parent's user requirements unless opted out, within the pin budget", () => {
		const state = parent();
		const pinned = state.resolve()!;
		expect(pinned.included.filter(entry => entry.pinned).map(entry => entry.id)).toEqual([
			state.item("REQ_ALPHA").id,
			state.item("STEER_BETA").id,
		]);

		expect(state.resolve({ request: { pinRequirements: false } })!.seed).toBeUndefined();

		const huge = parent({ firstRequirement: `REQ_ALPHA ${"pasted log line\n".repeat(4_000)}` });
		const capped = huge.resolve()!;
		expect(capped.omitted).toEqual([expect.objectContaining({ id: huge.item("REQ_ALPHA").id, pinned: true })]);
		expect(capped.included.map(entry => entry.id)).toEqual([huge.item("STEER_BETA").id]);
	});

	it("withholds parent reasoning from independent reviewers, even when requested", async () => {
		const state = parent();
		const thought = state.item("REASONING_NEEDLE");
		const read = state.item("ARTIFACT_NEEDLE");
		const review = state.resolve({ agent: { name: "reviewer" }, request: { refs: [thought.id, read.id] } })!;
		expect(review.independent).toBe(true);
		expect(review.excluded).toEqual([thought.id]);
		expect(review.seed).not.toContain("REASONING_NEEDLE");
		expect(review.seed).toContain("ARTIFACT_NEEDLE");
		expect(review.manifest).not.toContain(thought.id);
		expect(review.grant?.excludeKinds).toEqual(["assistant", "note", "summary"]);
		expect(formatHandoffCost("Rev", review)).toContain(`withheld from independent reviewer: ${thought.id}`);
		// Explicit frontmatter beats the name heuristic in both directions.
		expect(
			state.resolve({ agent: { name: "reviewer", independent: false }, request: { refs: [thought.id] } })!.excluded,
		).toEqual([]);
		expect(
			state.resolve({ agent: { name: "task", independent: true }, request: { refs: [thought.id] } })!.excluded,
		).toEqual([thought.id]);
		expect(() => state.resolve({ agent: { name: "verifier" }, request: { mode: "fork" } })).toThrow(
			/independent reviewer/,
		);
	});

	it("enforces the soft cap by omitting whole items and reporting their ids", () => {
		const state = parent({ firstRequirement: "large requirement\n".repeat(4000) });
		const read = state.item("ARTIFACT_NEEDLE");
		const large = state.item("large requirement");
		const handoff = state.resolve({
			request: { refs: [read.id, large.id], pinRequirements: false },
			capTokens: 1000,
		})!;
		expect(handoff.included.map(entry => entry.id)).toEqual([read.id]);
		expect(handoff.omitted.map(entry => entry.id)).toEqual([large.id]);
		expect(handoff.tokens).toBeLessThanOrEqual(1000);
		expect(handoff.seed).toContain(large.id);
		expect(formatHandoffCost("Worker", handoff)).toContain(large.id);
	});

	it("budgets with the parent archive's tokenizer, so cost and cap agree with the archive listing", () => {
		// Dense log text: the parent's model tokenizer counts it far above a bytes/4 estimate.
		const medium = parent({ tokenizer: new CharTokenizer(), firstRequirement: "dense 0x1f2e;\n".repeat(800) });
		const log = medium.item("dense 0x1f2e");
		const fits = medium.resolve({ request: { refs: [log.id], pinRequirements: false } })!;
		expect(fits.included.map(entry => entry.id)).toEqual([log.id]);
		// The reported cost covers at least the item as the archive sizes it, plus the envelope.
		expect(fits.tokens).toBeGreaterThan(log.tokens);
		expect(formatHandoffCost("Worker", fits)).toContain(`~${(fits.tokens / 1000).toFixed(1)}k tokens`);

		const large = parent({ tokenizer: new CharTokenizer(), firstRequirement: "dense 0x1f2e;\n".repeat(2_000) });
		const big = large.item("dense 0x1f2e");
		expect(big.tokens).toBeGreaterThan(HANDOFF_SOFT_CAP_TOKENS);
		const capped = large.resolve({ request: { refs: [big.id], pinRequirements: false } })!;
		expect(capped.omitted.map(entry => entry.id)).toEqual([big.id]);
		expect(capped.included).toEqual([]);
	});

	it("gives a CLM parent's brief spawn only the read-only archive grant, and refuses curated without CLM", () => {
		const state = parent();
		const brief = state.resolve({ request: { mode: "brief" } })!;
		expect(brief.mode).toBe("brief");
		expect([brief.seed, brief.manifest, brief.included, brief.tokens]).toEqual([undefined, undefined, [], 0]);
		expect(brief.grant?.access).toBe(state.access);
		expect(brief.grant?.excludeKinds).toEqual([]);
		expect(formatHandoffCost("Brief", brief)).toBeUndefined();
		expect(state.resolve({ agent: { name: "reviewer" }, request: { mode: "brief" } })!.grant?.excludeKinds).toEqual([
			"assistant",
			"note",
			"summary",
		]);
		expect(() => state.resolve({ request: { mode: "brief", refs: [state.item("REQ_ALPHA").id] } })).toThrow(/brief/);
		state.disable();
		expect(state.resolve()).toBeUndefined();
		expect(state.resolve({ request: { mode: "brief" } })).toBeUndefined();
		expect(() => state.resolve({ request: { refs: [state.item("REQ_ALPHA").id] } })).toThrow(
			/needs this session's CLM/,
		);
		expect(() => state.resolve({ request: { mode: "fork" } })).toThrow(/CLM context/);
		expect(() => state.resolve({ request: { mode: "fork" }, parentSessionFile: "/s/p.jsonl" })).toThrow(
			/CLM context/,
		);
	});

	it("seeds an editable block: the child's CLM may delete it, unlike its assignment", () => {
		const state = parent();
		const seed = state.resolve()!.seed!;
		const child = createClmDocument(
			[
				{ role: "custom", customType: CLM_HANDOFF_MESSAGE_TYPE, content: seed, display: false, timestamp: 10 },
				{ role: "user", content: "Complete assignment thoroughly: fix the lexer", timestamp: 11 },
			],
			{ revision: "r", snapshotId: "s", protectedIndexes: new Set([1]) },
		);
		expect(child.blocks.map(block => block.protected === true)).toEqual([false, true]);
	});
});

describe("context://parent scoped grant", () => {
	function child(state: { access: ClmContext }, excludeKinds: ClmArchiveItem["kind"][] = []) {
		const manager = SessionManager.inMemory("/repo");
		const session: ToolSession = {
			cwd: "/repo",
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getSessionId: () => manager.getSessionId(),
			sessionManager: manager,
			parentClmArchive: { access: state.access, ownerSessionId: state.access.ownerSessionId, excludeKinds },
		};
		return session;
	}

	it("lets the child read the parent's archive with parent-scoped hints", async () => {
		const state = parent();
		const router = new InternalUrlRouter();
		const session = child(state);
		const read = state.item("ARTIFACT_NEEDLE");
		const manifest = (await router.resolve("context://parent/archive", { session })).content;
		expect(manifest).toContain(read.id);
		expect(manifest).toContain("context://parent/archive/<id>");
		expect((await router.resolve(`context://parent/archive/${read.id}`, { session })).content).toBe(read.text);
		const search = (await router.resolve("context://parent/archive?q=ARTIFACT_NEEDLE&rerank=0", { session })).content;
		expect(search).toContain(read.id);
	});

	it("never writes, stages, or reaches beyond the parent's archive", async () => {
		const state = parent();
		const router = new InternalUrlRouter();
		const session = child(state);
		await expect(router.write("context://parent", "{}", { session })).rejects.toThrow(/read-only/);
		await expect(router.write("context://parent/archive", "{}", { session })).rejects.toThrow(/read-only/);
		expect(router.writeTier("context://parent", "{}", session)).toMatchObject({ policy: "deny" });
		for (const route of ["context://parent", "context://parent/status", "context://parent/history"]) {
			await expect(router.resolve(route, { session })).rejects.toThrow(/serves only \/archive/);
		}
		// The child's own document still requires its own capability; the grant is not one.
		await expect(router.resolve("context://self", { session })).rejects.toThrow(/unavailable/);
		// Only the spawning parent is addressable; no other session id can be named.
		await expect(router.resolve(`context://${state.manager.getSessionId()}/archive`, { session })).rejects.toThrow(
			/self or parent/,
		);
	});

	it("lets a CLM parent's brief child read the archive through its brief grant", async () => {
		const state = parent();
		const router = new InternalUrlRouter();
		const grant = state.resolve({ request: { mode: "brief" } })!.grant;
		const session: ToolSession = { ...child(state), parentClmArchive: grant };
		const read = state.item("ARTIFACT_NEEDLE");
		expect((await router.resolve(`context://parent/archive/${read.id}`, { session })).content).toBe(read.text);
	});

	it("refuses sessions without a grant and parents that are no longer live, naming the real reason", async () => {
		const state = parent();
		const router = new InternalUrlRouter();
		const orphan: ToolSession = { ...child(state), parentClmArchive: undefined, clmContext: state.access };
		await expect(router.resolve("context://parent/archive", { session: orphan })).rejects.toThrow(
			/No parent archive grant: this session is not a subagent of a CLM session/,
		);
		const session = child(state);
		state.disable();
		await expect(router.resolve("context://parent/archive", { session })).rejects.toThrow(
			/grant expired: the spawning parent's session ended or turned CLM off/,
		);
	});

	it("hides parent reasoning from a reviewer child's grant", async () => {
		const state = parent();
		const router = new InternalUrlRouter();
		const session = child(state, ["assistant", "note", "summary"]);
		const thought = state.item("REASONING_NEEDLE");
		await expect(router.resolve(`context://parent/archive/${thought.id}`, { session })).rejects.toThrow(
			/reviewer policy/,
		);
		expect((await router.resolve("context://parent/archive", { session })).content).not.toContain(thought.id);
	});
});
