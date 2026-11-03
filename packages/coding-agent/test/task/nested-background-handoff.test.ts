import { expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { taskToolRenderer, type TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AuthStorage } from "../../src/session/auth-storage";
import { ClmContext } from "../../src/session/clm-context";
import { SessionManager } from "../../src/session/session-manager";
import { TaskTool } from "../../src/task";
import type { ToolSession } from "../../src/tools";

it("shows a running background parent's nested child handoff before either agent settles", async () => {
	const temp = TempDir.createSync("@clm-nested-background-");
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth, temp.join("models.yml"));
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	const manager = SessionManager.create(temp.path(), temp.join("parent"));
	const nestedGate = Promise.withResolvers<void>();
	const nestedStarted = Promise.withResolvers<void>();
	const rootResumed = Promise.withResolvers<void>();
	const rootGate = Promise.withResolvers<void>();
	let rootCalls = 0;
	const provider = "clm-nested-background";
	try {
		const mock = createMockModel({
			provider,
			id: "worker",
			handler: async context => {
				const lastUser = context.messages.filter(message => message.role === "user").at(-1);
				if (JSON.stringify(lastUser).includes("NESTED_ASSIGNMENT")) {
					nestedStarted.resolve();
					await nestedGate.promise;
					return { content: [{ type: "toolCall", name: "yield", arguments: { data: { done: "nested" } } }] };
				}
				if (rootCalls++ === 0) {
					return {
						content: [
							{
								type: "toolCall",
								name: "task",
								arguments: {
									agent: "nested-worker",
									name: "Nested",
									task: "NESTED_ASSIGNMENT",
									solutionSpace: "open",
									handoffMode: "brief",
								},
							},
						],
					};
				}
				rootResumed.resolve();
				await rootGate.promise;
				return { content: [{ type: "toolCall", name: "yield", arguments: { data: { done: "root" } } }] };
			},
		});
		auth.keys.setRuntime(provider, "test-key");
		registry.registerProvider(provider, {
			api: provider,
			baseUrl: "mock://",
			apiKey: "test-key",
			models: [
				{
					id: "worker",
					name: "Nested worker",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 4096,
				},
			],
		});
		registerCustomApi(provider, mock.stream, provider);
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.batch": true,
			"compaction.experimentalClm": true,
			"compaction.enabled": false,
			"task.isolation.enabled": false,
			"todo.enabled": false,
			"retry.enabled": false,
		});
		const requirement = { role: "user" as const, content: "PARENT_REQUIREMENT", timestamp: 1 };
		manager.appendMessage(requirement);
		await manager.ensureOnDisk();
		const access = new ClmContext({
			manager,
			enabled: () => true,
			epoch: () => "nested",
			isDisposed: () => false,
			isStreaming: () => false,
			model: () => undefined,
			messages: () => [requirement],
			estimate: () => 0,
			assertFits: () => {},
			persistTurn: async () => true,
			publish: () => {},
			notice: () => {},
		});
		const session: ToolSession = {
			cwd: temp.path(),
			hasUI: false,
			settings,
			modelRegistry: registry,
			authStorage: auth,
			asyncJobManager: jobs,
			getSessionFile: () => manager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			getAgentId: () => null,
			getSessionId: () => access.ownerSessionId,
			sessionManager: manager,
			clmContext: access,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			getModelString: () => `${provider}/worker`,
			getSessionAgents: () => [
				{
					name: "root-worker",
					description: "Root worker",
					systemPrompt: "Complete the assignment.",
					source: "bundled",
					model: [`${provider}/worker`],
					tools: ["task", "yield"],
					independent: false,
					spawns: "*",
				},
				{
					name: "nested-worker",
					description: "Nested worker",
					systemPrompt: "Complete the assignment.",
					source: "bundled",
					model: [`${provider}/worker`],
					tools: ["yield"],
					independent: false,
					blocking: true,
				},
			],
		};
		const tool = await TaskTool.create(session);
		const result = await tool.execute("tc-nested-background", {
			agent: "root-worker",
			name: "Root",
			task: "ROOT_ASSIGNMENT",
			solutionSpace: "open",
		});
		const job = jobs.getJob(result.details!.async!.jobId)!;
		await Promise.race([
			nestedStarted.promise,
			job.promise.then(() => {
				throw new Error(`Root settled before starting the nested child: ${JSON.stringify(job.latestDetails)}`);
			}),
		]);
		// Nested executor startup follows the parent's tool_execution_update; it is still gated below.
		const theme = (await getThemeByName("titanium"))!;
		const render = () =>
			Bun.stripANSI(
				taskToolRenderer
					.renderResult(
						{
							content: [{ type: "text", text: "running" }],
							details: job.latestDetails as unknown as TaskToolDetails,
						},
						{ expanded: true, isPartial: true },
						theme,
					)
					.render(140)
					.join("\n"),
			);
		expect(job.status).toBe("running");
		const live = render();
		expect(live).toContain("Root>Nested");
		expect(live).toContain("brief");
		nestedGate.resolve();
		await rootResumed.promise;
		expect(job.status).toBe("running");
		expect(render()).toContain("Root>Nested");
		expect(render()).toContain("brief");
		rootGate.resolve();
		await job.promise;
		expect(job.status).toBe("completed");
		expect(render()).toContain("Root>Nested");
		expect(render()).toContain("brief");
	} finally {
		nestedGate.resolve();
		rootGate.resolve();
		await jobs.dispose({ timeoutMs: 5000 });
		await AgentLifecycleManager.global().dispose();
		AgentRegistry.resetGlobalForTests();
		await manager.close();
		registry.unregisterProvider(provider);
		unregisterCustomApis(provider);
		auth.close();
		temp.removeSync();
	}
}, 30_000);
