import { describe, expect, it } from "bun:test";
import { agentLoop } from "../src/agent-loop";
import { defaultConvertToLlm } from "../src/compaction/messages";
import type { AgentContext, AgentLoopConfig } from "../src/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

describe("request admission output budgets", () => {
	it("never raises the caller's explicit reply cap", async () => {
		const mock = createMockModel({ responses: [{ content: ["Answer"] }] });
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: defaultConvertToLlm,
			maxTokens: 1024,
			admitRequest: () => ({ maxTokens: 4096 }),
		};
		await agentLoop(
			[{ role: "user", content: "Question", timestamp: 1 }],
			context,
			config,
			undefined,
			mock.stream,
		).result();
		expect(mock.calls[0].options?.maxTokens).toBe(1024);
	});

	it("dispatches the final cap after provider-context transforms", async () => {
		const mock = createMockModel({ responses: [{ content: ["Answer"] }] });
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: defaultConvertToLlm,
			maxTokens: 8192,
			admitRequest: () => ({ maxTokens: 4096 }),
			beforeModelCall: (_context, _signal, request) => {
				request.maxTokens = 2048;
			},
		};
		await agentLoop(
			[{ role: "user", content: "Question", timestamp: 1 }],
			context,
			config,
			undefined,
			mock.stream,
		).result();
		expect(mock.calls[0].options?.maxTokens).toBe(2048);
	});
});
