import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createCompactionSummaryMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "../../src/config/settings";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { ClmContext } from "../../src/session/clm-context";
import { SessionManager } from "../../src/session/session-manager";
import { resolveTaskHandoff } from "../../src/task/handoff";
import type { ToolSession } from "../../src/tools";

function parent(requirement: string) {
	const manager = SessionManager.inMemory("/repo");
	const initial = { role: "user" as const, content: requirement, timestamp: 1 };
	const messages: AgentMessage[] = [initial];
	let disposed = false;
	const access = new ClmContext({
		manager,
		enabled: () => true,
		epoch: () => "epoch",
		isDisposed: () => disposed,
		isStreaming: () => false,
		model: () => undefined,
		messages: () => messages,
		estimate: () => 0,
		assertFits: () => {},
		persistTurn: async () => true,
		publish: () => {},
		notice: () => {},
	});
	const append = (message: AgentMessage) => {
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			manager.appendMessage(message);
		}
		messages.push(message);
	};
	manager.appendMessage(initial);
	return {
		manager,
		messages,
		access,
		append,
		dispose: () => {
			disposed = true;
		},
	};
}

function child(state: { access: ClmContext }, independent = false): ToolSession {
	const manager = SessionManager.inMemory("/repo");
	const handoff = resolveTaskHandoff({
		access: state.access,
		request: { pinRequirements: false },
		agent: { name: "worker", independent },
		parentSessionFile: null,
	})!;
	return {
		cwd: "/repo",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => manager.getSessionId(),
		sessionManager: manager,
		parentClmArchive: handoff.grant,
	};
}

function thought(): AssistantMessage {
	return {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "test",
		stopReason: "stop",
		timestamp: 2,
		content: [{ type: "text", text: "PRIVATE_REASONING_NEEDLE" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("parent archive grant lifecycle", () => {
	it("never retargets a live child to a new parent session", async () => {
		const state = parent("ORIGINAL_REQUIREMENT");
		const session = child(state);
		const router = new InternalUrlRouter();
		expect((await router.resolve("context://parent/archive", { session })).content).toContain("ORIGINAL_REQUIREMENT");
		await state.manager.newSession();
		state.messages.length = 0;
		state.append({ role: "user", content: "UNRELATED_PRIVATE_REQUIREMENT", timestamp: 3 });
		await expect(router.resolve("context://parent/archive", { session })).rejects.toThrow(/parent archive grant/i);
	});

	it("remains usable after the spawning turn, sees later parent items, and stops on disposal", async () => {
		const state = parent("ORIGINAL_REQUIREMENT");
		const session = child(state);
		const router = new InternalUrlRouter();
		await Promise.resolve();
		state.append({ role: "user", content: "LATER_PARENT_REQUIREMENT", timestamp: 3 });
		const item = state.access.archive().items.find(value => value.text.includes("LATER_PARENT_REQUIREMENT"))!;
		expect((await router.resolve(`context://parent/archive/${item.id}`, { session })).content).toBe(item.text);
		state.dispose();
		await expect(router.resolve(`context://parent/archive/${item.id}`, { session })).rejects.toThrow(
			/parent archive grant/i,
		);
	});

	it("routes grandchildren only to their immediate parent's own archive", async () => {
		const ancestor = parent("ANCESTOR_ONLY_REQUIREMENT");
		const immediate = parent("IMMEDIATE_PARENT_REQUIREMENT");
		const immediateSession = { ...child(ancestor), clmContext: immediate.access };
		const grandchild = child({ access: immediateSession.clmContext });
		const router = new InternalUrlRouter();
		const manifest = (await router.resolve("context://parent/archive", { session: grandchild })).content;
		expect(manifest).toContain("IMMEDIATE_PARENT_REQUIREMENT");
		expect(manifest).not.toContain("ANCESTOR_ONLY_REQUIREMENT");
		const ancestorItem = ancestor.access.archive().items[0];
		await expect(
			router.resolve(`context://parent/archive/${ancestorItem.id}`, { session: grandchild }),
		).rejects.toThrow(/Unknown archive id/);
	});

	it("excludes reviewer reasoning from item, manifest, and lexical/regex search, but retains requirements", async () => {
		const state = parent("PUBLIC_REQUIREMENT_NEEDLE");
		state.append(thought());
		state.append({ role: "clmNote", content: "PRIVATE_NOTE_NEEDLE", timestamp: 3 });
		state.append(createCompactionSummaryMessage("PRIVATE_SUMMARY_NEEDLE", 10, "1970-01-01T00:00:00.004Z"));
		const session = child(state, true);
		const router = new InternalUrlRouter();
		const manifest = (await router.resolve("context://parent/archive", { session })).content;
		expect(manifest).toContain("PUBLIC_REQUIREMENT_NEEDLE");
		expect(manifest).not.toContain("PRIVATE_");
		for (const item of state.access
			.archive()
			.items.filter(value => ["assistant", "note", "summary"].includes(value.kind))) {
			await expect(router.resolve(`context://parent/archive/${item.id}`, { session })).rejects.toThrow(
				/reviewer policy/,
			);
		}
		for (const query of ["PRIVATE_&rerank=0", "PRIVATE_.*NEEDLE&regex=1"]) {
			const search = (await router.resolve(`context://parent/archive?q=${query}`, { session })).content;
			for (const item of state.access
				.archive()
				.items.filter(value => ["assistant", "note", "summary"].includes(value.kind))) {
				expect(search).not.toContain(item.id);
			}
		}
	});
});
