import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../src/config/settings";
import { InternalUrlRouter } from "../src/internal-urls/router";
import { ClmContext } from "../src/session/clm-context";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";

class ExactTokenizer extends Tokenizer {
	override countTokens(text: string | string[]): number {
		return super.countTokens(text, "strict");
	}
}

function harness() {
	const manager = SessionManager.inMemory("/tmp");
	const historical: AgentMessage = { role: "user", content: "OLD_ARCHIVE_NEEDLE", timestamp: 1 };
	const tail: AgentMessage = { role: "user", content: "CURRENT_CONSTRAINT", timestamp: 2 };
	manager.appendMessage(historical);
	manager.appendMessage(tail);
	const agent = new Agent({ initialState: { messages: [historical, tail] } });
	let tokenizer = new Tokenizer();
	const clm = new ClmContext({
		tokenizer: () => tokenizer,
		manager,
		enabled: () => true,
		epoch: () => "initial",
		isDisposed: () => false,
		isStreaming: () => agent.state.isStreaming,
		model: () => agent.state.model,
		messages: () => agent.state.messages,
		estimate: messages => JSON.stringify(messages).length,
		assertFits: () => {},
		persistTurn: async () => true,
		publish: messages => agent.replaceMessages(messages),
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
	return {
		manager,
		agent,
		clm,
		session,
		historical,
		tail,
		router: new InternalUrlRouter(),
		setTokenizer: (value: Tokenizer) => {
			tokenizer = value;
		},
	};
}

describe("CLM archive live integration adversaries", () => {
	it("refreshes manifest membership, search, and expansion after a same-length rewrite with the same journal leaf and tail", async () => {
		const state = harness();
		const leaf = state.manager.getLeafId();
		await state.router.resolve("context://self/archive", { session: state.session });
		state.agent.replaceMessages([{ ...state.historical, content: "REPLACEMENT_ARCHIVE_NEEDLE" }, state.tail]);
		expect(state.manager.getLeafId()).toBe(leaf);
		expect(state.agent.state.messages.at(-1)).toBe(state.tail);
		const manifest = await state.router.resolve("context://self/archive", { session: state.session });
		const oldLine = manifest.content.split("\n").find(line => line.endsWith("OLD_ARCHIVE_NEEDLE"));
		expect(oldLine).not.toContain("in-context");
		const replacement = manifest.content.split("\n").find(line => line.endsWith("REPLACEMENT_ARCHIVE_NEEDLE"));
		expect(replacement).toContain("in-context");
		const search = await state.router.resolve("context://self/archive?q=REPLACEMENT_ARCHIVE_NEEDLE&rerank=0", {
			session: state.session,
		});
		expect(search.content).toContain("REPLACEMENT_ARCHIVE_NEEDLE");
		const id = replacement!.split(" ")[0];
		const expanded = await state.router.resolve(`context://self/archive/${id}`, { session: state.session });
		expect(expanded.content).toBe("REPLACEMENT_ARCHIVE_NEEDLE");
	});

	it("refreshes archived text after an in-place message content change with unchanged identities", async () => {
		const state = harness();
		await state.router.resolve("context://self/archive", { session: state.session });
		state.historical.content = "MUTATED_ARCHIVE_NEEDLE";
		const manifest = await state.router.resolve("context://self/archive", { session: state.session });
		expect(manifest.content).toContain("MUTATED_ARCHIVE_NEEDLE");
		expect(manifest.content).not.toContain("OLD_ARCHIVE_NEEDLE");
	});
	it("refreshes journal-only items after an in-place rewrite without changing the live context", async () => {
		const state = harness();
		state.agent.replaceMessages([state.tail]);
		await state.router.resolve("context://self/archive", { session: state.session });
		const leaf = state.manager.getLeafId();
		state.historical.content = "REWRITTEN_JOURNAL_NEEDLE";
		await state.manager.rewriteEntries();
		expect(state.manager.getLeafId()).toBe(leaf);
		const manifest = await state.router.resolve("context://self/archive", { session: state.session });
		expect(manifest.content).toContain("REWRITTEN_JOURNAL_NEEDLE");
		expect(manifest.content).not.toContain("OLD_ARCHIVE_NEEDLE");
	});

	it("refreshes item token sizes when the budget tokenizer changes without changing context", () => {
		const state = harness();
		state.historical.content = "hello ".repeat(200);
		const before = state.clm.archive().items.find(item => item.text === state.historical.content)!;
		const exact = new ExactTokenizer();
		const expected = exact.countTokens(before.text);
		expect(before.tokens).not.toBe(expected);
		state.setTokenizer(exact);
		const after = state.clm.archive().get(before.id)!;
		expect(after.tokens).toBe(expected);
	});
});

describe("CLM archive URL parameter boundaries", () => {
	it.each([
		["offset", "9007199254740993"],
		["limit", "9007199254740993"],
		["offset", "9".repeat(400)],
		["limit", "9".repeat(400)],
	])("rejects unsafe integer parameter %s=%s before pagination", async (name, value) => {
		const state = harness();
		await expect(
			state.router.resolve(`context://self/archive?${name}=${value}`, { session: state.session }),
		).rejects.toThrow(/safe.*integer/i);
	});

	it.each([
		"offset=0&offset=1",
		"limit=1&limit=2",
		"q=OLD_ARCHIVE_NEEDLE&q=CURRENT_CONSTRAINT",
		"q=OLD_ARCHIVE_NEEDLE&regex=0&regex=1",
		"q=OLD_ARCHIVE_NEEDLE&rerank=0&rerank=1",
	])("rejects ambiguous repeated parameters: %s", async query => {
		const state = harness();
		await expect(state.router.resolve(`context://self/archive?${query}`, { session: state.session })).rejects.toThrow(
			/duplicate.*parameter/i,
		);
	});

	it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
		"rejects inherited object key %s as an unknown parameter",
		async name => {
			const state = harness();
			for (const query of [`${name}=1`, `q=OLD_ARCHIVE_NEEDLE&${name}=1&rerank=0`]) {
				await expect(
					state.router.resolve(`context://self/archive?${query}`, { session: state.session }),
				).rejects.toThrow(`Unknown archive parameter ${name}`);
			}
		},
	);
});
