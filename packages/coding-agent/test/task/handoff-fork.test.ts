import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import subagentForkSwitchPrompt from "../../src/prompts/system/subagent-fork-switch.md" with { type: "text" };
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { convertToLlm } from "../../src/session/messages";

const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(timestamp: number, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
		usage,
		content,
	};
}

function text(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : JSON.stringify(part))).join("\n");
}

describe("task fork handoff", () => {
	const cleanup: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step();
	});

	it("ends the child's first request with the role-switch notice and assignment, without the parent's in-flight task call", async () => {
		const dir = TempDir.createSync("@omp-handoff-fork-");
		cleanup.push(() => dir.remove());
		const parent = SessionManager.create(dir.path(), dir.join("parent"));
		parent.appendMessage({ role: "user", content: "REQ: report rows are TAB-separated", timestamp: 1 });
		parent.appendMessage(assistant(2, [{ type: "text", text: "Understood." }]));
		parent.appendMessage({ role: "user", content: "Now hand the shipping work off to ONE subagent", timestamp: 3 });
		// Completed work earlier in the delegating turn stays inherited.
		parent.appendMessage(assistant(4, [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "spec" } }]));
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "r1",
			toolName: "read",
			content: [{ type: "text", text: "SPEC_NEEDLE drop path inbox/daily.tsv" }],
			isError: false,
			timestamp: 5,
		});
		// The in-flight turn: the task call that is spawning this very child.
		parent.appendMessage(
			assistant(6, [
				{ type: "text", text: "Delegating now." },
				{ type: "toolCall", id: "t1", name: "task", arguments: { agent: "worker", handoffMode: "fork" } },
			]),
		);
		await parent.ensureOnDisk();
		await parent.flush();
		cleanup.push(() => parent.close());

		const fork = await SessionManager.forkFrom(parent.getSessionFile()!, dir.path(), dir.join("child"), undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			resetInheritedCost: true,
			excludeInFlightTurn: true,
		});
		cleanup.push(() => fork.close());

		const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		cleanup.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model");
		const provider = createMockModel({ provider: "anthropic", handler: { content: ["done"] } });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: bundled, systemPrompt: ["Child"], tools: [], messages: [] },
				streamFn: provider.stream,
				convertToLlm,
			}),
			sessionManager: fork,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		cleanup.push(() => session.dispose());
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		await session.sendCustomMessage(
			{ customType: "subagent-fork", content: subagentForkSwitchPrompt, display: false },
			{ triggerTurn: false },
		);
		await session.prompt("ASSIGNMENT: write the report and commit it");
		await session.waitForIdle();

		const request = provider.calls[0]!.context.messages;
		const calls = request.flatMap(message =>
			message.role === "assistant" ? message.content.filter(part => part.type === "toolCall") : [],
		);
		expect(calls.map(call => call.name)).toEqual(["read"]);
		expect(request.some(message => message.role === "toolResult" && message.toolCallId === "t1")).toBe(false);
		expect(request.map(text).join("\n")).not.toContain("Delegating now.");
		expect(request.map(text).join("\n")).toContain("SPEC_NEEDLE");
		expect(request.at(-2)?.role).toBe("developer");
		expect(text(request.at(-1)!)).toContain("ASSIGNMENT: write the report and commit it");
		// The child's journal (what revival replays) holds no trace of the parent's in-flight call.
		await fork.flush();
		const reopened = await SessionManager.open(fork.getSessionFile()!, dir.path());
		cleanup.push(() => reopened.close());
		expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain('"t1"');
	});
});
