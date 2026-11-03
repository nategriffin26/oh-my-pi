/**
 * Contract: rewinding the session tree while a turn is running stops that turn.
 *
 * The running loop owns a private copy of the context it sends. If navigation
 * only moved the leaf and rebuilt the agent state, the loop kept answering the
 * abandoned history: its reply was appended to the rewound branch even though
 * the model had read the message the user just took back, and every later
 * owned-state commit (CLM edits) compared two different histories and failed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function text(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

describe("AgentSession tree navigation during a running turn", () => {
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		fixtureDir = path.join(os.tmpdir(), `pi-tree-running-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(fixtureDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	beforeEach(() => {
		session = undefined;
	});

	afterEach(async () => {
		await session?.dispose();
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	it("stops the turn that already read a rewound user message", async () => {
		const mock = createMockModel({
			responses: [{ content: ["initial response"] }, { content: ["reply to the garbled steer"], delayMs: 2_000 }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await session.prompt("hello");
		const steerDelivered = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "message_end" && event.message.role === "user" && text(event.message) === "garbled steer")
				steerDelivered.resolve();
		});
		await session.steer("garbled steer");
		await steerDelivered.promise;
		expect(mock.calls.length).toBe(2);

		const steerEntry = sessionManager
			.getBranch()
			.find(entry => entry.type === "message" && text(entry.message) === "garbled steer");
		if (!steerEntry) throw new Error("steer was not persisted");
		const result = await session.navigateTree(steerEntry.id, { summarize: false });
		await session.waitForIdle();

		expect(result.editorText).toBe("garbled steer");
		expect(session.isStreaming).toBe(false);
		const branch = sessionManager.buildSessionContext().messages.map(message => [message.role, text(message)]);
		expect(branch).toEqual([
			["user", "hello"],
			["assistant", "initial response"],
		]);
		expect(session.agent.state.messages.map(message => [message.role, text(message)])).toEqual(branch);
	});
});
