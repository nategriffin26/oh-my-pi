import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession, discoverAuthStorage } from "../../src/sdk";
import type { CreateAgentSessionOptions } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { resolveEffectiveSubagentPolicy } from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { ReadTool } from "../../src/tools/read";

const worker: AgentDefinition = {
	name: "grant-review-worker",
	description: "Grant boundary worker",
	systemPrompt: "Inspect the assigned archive.",
	source: "project",
	independent: false,
	tools: ["read"],
};

function text(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

describe("brief and eval parent archive boundaries", () => {
	let temp: TempDir;
	let registry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		temp = TempDir.createSync("omp-parent-grant-review-");
		registry = new ModelRegistry(await discoverAuthStorage(temp.path()));
	});
	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose();
	});
	afterAll(() => {
		registry.authStorage.close();
		temp.removeSync();
	});

	async function launch(options: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.inMemory(temp.path()),
			settings: Settings.isolated({ "compaction.experimentalClm": true, "task.isolation.enabled": false }),
			bindProcessState: false,
			toolNames: ["read"],
			restrictToolNames: true,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			workspaceTree: { rootPath: temp.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			...options,
		});
		sessions.push(session);
		return session;
	}

	function seed(session: AgentSession, marker: string): string {
		const message: AgentMessage = { role: "user", content: marker, timestamp: 1 };
		session.sessionManager.appendMessage(message);
		session.agent.replaceMessages([message]);
		const item = session
			.getClmContext()
			.archive()
			.items.find(item => item.text.includes(marker));
		if (!item) throw new Error("Missing seeded archive item");
		return item.id;
	}

	function toolSession(session: AgentSession, inherited?: ToolSession["parentClmArchive"]): ToolSession {
		return {
			cwd: temp.path(),
			hasUI: false,
			settings: session.settings,
			sessionManager: session.sessionManager,
			getSessionFile: () => session.sessionFile ?? null,
			getSessionId: () => session.sessionManager.getSessionId(),
			getSessionSpawns: () => "*",
			getSessionAgents: () => [worker],
			clmContext: session.getClmContext(),
			parentClmArchive: inherited,
		};
	}

	async function handoff(session: ToolSession, invocationKind: "task" | "eval", agent = worker) {
		session.getSessionAgents = () => [agent];
		return (
			await resolveEffectiveSubagentPolicy({
				session,
				invocationKind,
				assignment: "Inspect the archive",
				agent: agent.name,
				handoff: { mode: "brief" },
			})
		).handoff;
	}

	it("does not expose an injected parent grant to a top-level SDK session", async () => {
		const parent = await launch();
		const id = seed(parent, "PRIVATE_PARENT_ITEM");
		const grant = (await handoff(toolSession(parent), "task"))!.grant;
		const topLevel = await launch({ parentClmArchive: grant });
		const read = topLevel.getToolByName("read")!;
		await expect(read.execute("top-level-read", { path: `context://parent/archive/${id}` })).rejects.toThrow();
	});

	it("retires the parent grant when its recipient starts an unrelated session", async () => {
		const parent = await launch();
		const id = seed(parent, "RECIPIENT_BOUND_PARENT_ITEM");
		const grant = (await handoff(toolSession(parent), "eval"))!.grant;
		const child = await launch({ taskDepth: 1, parentTaskPrefix: "GrantChild", parentClmArchive: grant });
		const read = child.getToolByName("read")!;
		expect(text(await read.execute("before-switch", { path: `context://parent/archive/${id}` }))).toContain(
			"RECIPIENT_BOUND_PARENT_ITEM",
		);
		expect(await child.newSession()).toBe(true);
		await expect(read.execute("after-switch", { path: `context://parent/archive/${id}` })).rejects.toThrow();
	});

	it("does not issue a grant from an advisor or foreign journal alias", async () => {
		const parent = await launch();
		seed(parent, "FOREIGN_OWNER_ITEM");
		const base = toolSession(parent);
		const aliases = [
			{ ...base, getSessionId: () => `${parent.sessionManager.getSessionId()}-advisor` },
			{ ...base, sessionManager: SessionManager.inMemory(temp.path()) },
		];
		for (const alias of aliases) {
			for (const kind of ["task", "eval"] as const) {
				const resolved = await handoff(alias, kind);
				const recipient = { ...base, clmContext: undefined, parentClmArchive: resolved?.grant };
				await expect(
					new ReadTool(recipient).execute("foreign-read", { path: "context://parent/archive" }),
				).rejects.toThrow();
			}
		}
	});

	it("addresses only the immediate CLM parent, never an inherited ancestor grant", async () => {
		const root = await launch();
		const rootId = seed(root, "ROOT_ONLY_ITEM");
		const rootGrant = (await handoff(toolSession(root), "task"))!.grant;
		const parent = await launch({ taskDepth: 1, parentTaskPrefix: "Middle", parentClmArchive: rootGrant });
		const parentId = seed(parent, "MIDDLE_ONLY_ITEM");
		for (const kind of ["task", "eval"] as const) {
			const grant = (await handoff(toolSession(parent, rootGrant), kind))!.grant;
			const child = await launch({ taskDepth: 2, parentTaskPrefix: `Leaf-${kind}`, parentClmArchive: grant });
			const read = child.getToolByName("read")!;
			expect(text(await read.execute("middle-read", { path: `context://parent/archive/${parentId}` }))).toContain(
				"MIDDLE_ONLY_ITEM",
			);
			await expect(read.execute("root-read", { path: `context://parent/archive/${rootId}` })).rejects.toThrow();
		}
		const noClm = toolSession(parent, rootGrant);
		noClm.clmContext = undefined;
		for (const kind of ["task", "eval"] as const) {
			const grant = (await handoff(noClm, kind))?.grant;
			await expect(
				new ReadTool({ ...noClm, parentClmArchive: grant }).execute("no-parent-read", {
					path: "context://parent/archive",
				}),
			).rejects.toThrow();
		}
	});

	it("enforces reviewer exclusions for both brief task and eval grants on item, manifest, and search reads", async () => {
		const parent = await launch();
		seed(parent, "REVIEW_ALLOWED_REQUIREMENT");
		const model = getBundledModel("openai", "gpt-4o-mini")!;
		const reasoning: AgentMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "REVIEW_FORBIDDEN_REASONING" }],
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		parent.sessionManager.appendMessage(reasoning);
		parent.agent.replaceMessages([...parent.agent.state.messages, reasoning]);
		const hidden = parent
			.getClmContext()
			.archive()
			.items.find(item => item.text.includes("REVIEW_FORBIDDEN_REASONING"))!;
		for (const kind of ["task", "eval"] as const) {
			const grant = (await handoff(toolSession(parent), kind, { ...worker, independent: true }))!.grant;
			const child = await launch({ taskDepth: 1, parentTaskPrefix: `Review-${kind}`, parentClmArchive: grant });
			const read = child.getToolByName("read")!;
			await expect(read.execute("hidden-item", { path: `context://parent/archive/${hidden.id}` })).rejects.toThrow();
			const manifest = text(await read.execute("manifest", { path: "context://parent/archive" }));
			expect(manifest).toContain("REVIEW_ALLOWED_REQUIREMENT");
			expect(manifest).not.toContain(hidden.id);
			const search = text(
				await read.execute("search", {
					path: "context://parent/archive?q=REVIEW_FORBIDDEN_REASONING&rerank=0",
				}),
			);
			expect(search).not.toContain(hidden.id);
		}
	});
});
