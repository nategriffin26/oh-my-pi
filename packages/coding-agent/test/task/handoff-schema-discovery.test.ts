import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "../../src/config/settings";
import { ClmContext } from "../../src/session/clm-context";
import { SessionManager } from "../../src/session/session-manager";
import { parseAgent } from "../../src/task/agents";
import { discoverAgents } from "../../src/task/discovery";
import { resolveTaskHandoff, validateHandoffFields } from "../../src/task/handoff";
import { TaskTool } from "../../src/task/index";
import { resolveEffectiveSubagentPolicy } from "../../src/task/structured-subagent";
import { getTaskSchema } from "../../src/task/types";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import type { TaskItem } from "@oh-my-pi/pi-tui/tools/task";

function parent() {
	const manager = SessionManager.inMemory("/repo");
	manager.appendMessage({ role: "user", content: "REQUIREMENT: preserve public API", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "PARENT_REASONING: assume the lexer is wrong" }],
		api: "mock",
		provider: "mock",
		model: "handoff-boundaries",
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const access = new ClmContext({
		manager,
		enabled: () => true,
		epoch: () => "handoff-boundaries",
		isDisposed: () => false,
		isStreaming: () => false,
		model: () => undefined,
		messages: () => [],
		estimate: () => 0,
		assertFits: () => {},
		persistTurn: async () => true,
		publish: () => {},
		notice: () => {},
	});
	const reasoning = access.archive().items.find(item => item.text.includes("PARENT_REASONING"));
	if (!reasoning) throw new Error("Parent reasoning fixture was not archived");
	return { manager, access, reasoning };
}

function agent(name: string, independent?: boolean | string): AgentDefinition {
	return parseAgent(
		`${name}.md`,
		`---\nname: ${name}\ndescription: Handoff boundary probe\n${independent === undefined ? "" : `independent: ${JSON.stringify(independent)}\n`}---\nFollow the assignment.`,
		"project",
	);
}

function parsedRecord(parsed: unknown): Record<string, unknown> {
	if (parsed instanceof type.errors) throw new Error(parsed.summary);
	if (!parsed || typeof parsed !== "object") throw new Error("Expected parsed task object");
	return parsed as Record<string, unknown>;
}

const temporaryDirs: string[] = [];
afterEach(async () => {
	for (const dir of temporaryDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function temporaryProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-handoff-schema-"));
	temporaryDirs.push(dir);
	return dir;
}

function session(cwd: string, access?: ClmContext, manager?: SessionManager): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "task.batch": true, "task.isolation.enabled": false, "async.enabled": false }),
		getSessionFile: () => "/tmp/handoff-parent.jsonl",
		getSessionSpawns: () => "*",
		getSessionId: () => manager?.getSessionId() ?? null,
		sessionManager: manager,
		clmContext: access,
	};
}

describe("handoff wire boundaries", () => {
	it.each([false, true])("leaves CLM-off single/batch parsing unchanged (batch=%s)", batchEnabled => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled, handoffEnabled: false });
		const item = {
			task: "Inspect the API",
			solutionSpace: "one known API",
			handoff: ["invalid ref"],
			handoffMode: "fork",
			pinRequirements: false,
		};
		const baseline = { task: item.task, solutionSpace: item.solutionSpace };
		const input = batchEnabled ? { context: "Shared background", tasks: [item] } : item;
		const expected = batchEnabled ? { context: "Shared background", tasks: [baseline] } : baseline;
		expect(parsedRecord(schema(input))).toEqual(parsedRecord(schema(expected)));
	});

	it("accepts independent modes within one CLM-enabled batch and rejects malformed fields", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true, handoffEnabled: true });
		const tasks = [
			{ task: "Use evidence", solutionSpace: "known fix", handoff: ["h0123456789:2-4"], pinRequirements: false },
			{ task: "Fresh perspective", solutionSpace: "open cause", handoffMode: "brief" },
			{ task: "Continue work", solutionSpace: "known change", handoffMode: "fork" },
		];
		const parsed = parsedRecord(schema({ context: "Shared contract", tasks }));
		expect(parsed.tasks).toEqual(tasks.map(item => ({ ...item, agent: "task" })));
		for (const fields of [
			{ handoff: "h0123456789" },
			{ handoffMode: ["fork"] },
			{ handoffMode: "unknown" },
			{ pinRequirements: "false" },
		]) {
			expect(
				schema({
					context: "Shared contract",
					tasks: [{ task: "Inspect", solutionSpace: "known", ...fields }],
				}) instanceof type.errors,
			).toBe(true);
		}
	});

	it("rejects a non-string runtime mode instead of coercing it into a valid mode", () => {
		const malformed = { handoffMode: ["fork"] } as unknown as TaskItem;
		expect(validateHandoffFields(malformed, "Task 2")).toContain("invalid `handoffMode`");
	});
});

describe("independent role detection", () => {
	it.each([
		"reviewer",
		"security-reviewer",
		"securityReviewer",
		"APIReviewer",
		"verifier-sonnet",
		"verification",
		"audit",
		"codeCritique",
	])("withholds reasoning and refuses forks for %s", name => {
		const state = parent();
		const selected = agent(name);
		const resolved = resolveTaskHandoff({
			access: state.access,
			request: { refs: [state.reasoning.id] },
			agent: selected,
			parentSessionFile: "/tmp/parent.jsonl",
		})!;
		expect(resolved.excluded).toContain(state.reasoning.id);
		expect(resolved.seed).not.toContain("PARENT_REASONING");
		expect(resolved.grant?.excludeKinds).toContain(state.reasoning.kind);
		expect(() =>
			resolveTaskHandoff({
				access: state.access,
				request: { mode: "fork" },
				agent: selected,
				parentSessionFile: "/tmp/parent.jsonl",
			}),
		).toThrow(/independent reviewer/);
	});

	it.each(["preview-builder", "unverified-worker", "unaudited-parser", "critical-path", "researcher-sonnet"])(
		"does not strip reasoning from non-review role %s",
		name => {
			const state = parent();
			const resolved = resolveTaskHandoff({
				access: state.access,
				request: { refs: [state.reasoning.id], pinRequirements: false },
				agent: agent(name),
				parentSessionFile: null,
			})!;
			expect(resolved.included.map(item => item.id)).toContain(state.reasoning.id);
			expect(resolved.seed).toContain("PARENT_REASONING");
		},
	);

	it.each([
		["task", true, true],
		["reviewer", false, false],
		["task", "true", true],
		["verifier", "false", false],
	] as const)("frontmatter for %s overrides inferred role (%s)", (name, independent, expected) => {
		const state = parent();
		const selected = agent(name, independent);
		const resolved = resolveTaskHandoff({
			access: state.access,
			request: { refs: [state.reasoning.id] },
			agent: selected,
			parentSessionFile: null,
		})!;
		expect(selected.independent).toBe(expected);
		expect(resolved.excluded.includes(state.reasoning.id)).toBe(expected);
		expect(resolved.seed?.includes("PARENT_REASONING") ?? false).toBe(!expected);
	});

	it("preserves independent overrides through actual project discovery", async () => {
		const cwd = await temporaryProject();
		await Bun.write(
			path.join(cwd, ".omp", "agents", "specialist.md"),
			"---\nname: schema-specialist\ndescription: Independent specialist\nindependent: true\n---\nInspect facts.",
		);
		await Bun.write(
			path.join(cwd, ".omp", "agents", "reviewer.md"),
			"---\nname: schema-reviewer\ndescription: Continuation worker\nindependent: false\n---\nContinue work.",
		);
		const discovered = await discoverAgents(cwd);
		expect(discovered.searchedDirs).toContain(path.join(cwd, ".omp", "agents"));
		const state = parent();
		for (const [name, expected] of [
			["schema-specialist", true],
			["schema-reviewer", false],
		] as const) {
			const selected = discovered.agents.find(item => item.name === name);
			if (!selected) throw new Error(`Agent ${name} was not discovered`);
			const resolved = resolveTaskHandoff({
				access: state.access,
				request: { refs: [state.reasoning.id] },
				agent: selected,
				parentSessionFile: null,
			})!;
			expect(resolved.excluded.includes(state.reasoning.id)).toBe(expected);
		}
	});
});

describe("task handoff preflight", () => {
	it("resolves mixed curated/brief/fork policies without changing assignment or output contracts", async () => {
		const cwd = await temporaryProject();
		const state = parent();
		const current = session(cwd, state.access, state.manager);
		const outputSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
		const policies = await Promise.all(
			(["curated", "brief", "fork"] as const).map(mode =>
				resolveEffectiveSubagentPolicy({
					session: current,
					invocationKind: "task",
					agent: "task",
					assignment: "Inspect the API",
					context: "Keep the public contract",
					outputSchema,
					schemaMode: "strict",
					handoff: { mode },
				}),
			),
		);
		expect(policies.map(policy => policy.handoff?.mode ?? "brief")).toEqual(["curated", "brief", "fork"]);
		for (const policy of policies)
			expect(policy.schema).toEqual({
				schema: outputSchema,
				source: "caller",
				mode: "strict",
				outputSchemaOverridesAgent: true,
			});
		expect(policies[0]!.handoff?.seed).toContain("REQUIREMENT");
		// A CLM parent's brief child copies nothing but may still read the parent's archive.
		expect([policies[1]!.handoff?.seed, policies[1]!.handoff?.manifest]).toEqual([undefined, undefined]);
		expect(policies[1]!.handoff?.grant?.access).toBe(state.access);
	});

	it("rejects an explicit fork without CLM and keeps absent/brief handoffs blank", async () => {
		const cwd = await temporaryProject();
		const current = session(cwd);
		for (const handoff of [undefined, { mode: "brief" as const }]) {
			const policy = await resolveEffectiveSubagentPolicy({
				session: current,
				invocationKind: "task",
				agent: "task",
				assignment: "Inspect",
				handoff,
			});
			expect(policy.handoff).toBeUndefined();
		}
		await expect(
			resolveEffectiveSubagentPolicy({
				session: current,
				invocationKind: "task",
				agent: "task",
				assignment: "Inspect",
				handoff: { mode: "fork" },
			}),
		).rejects.toThrow(/CLM/);
	});

	it("rejects the invalid member of a mixed batch before allocating children", async () => {
		const cwd = await temporaryProject();
		const state = parent();
		const current = session(cwd, state.access, state.manager);
		const tool = await TaskTool.create(current);
		const result = await tool.execute("mixed-handoff", {
			context: "Shared contract",
			tasks: [
				{ name: "Curated", task: "Inspect", handoffMode: "curated" },
				{ name: "BadBrief", task: "Inspect", handoffMode: "brief", handoff: [state.reasoning.id] },
				{ name: "Fork", task: "Continue", handoffMode: "fork" },
			],
		});
		expect(result.content.find(part => part.type === "text")?.text).toContain(
			'Task 2 (`BadBrief`) sets `handoffMode: "brief"`',
		);
		expect(current.agentOutputManager).toBeUndefined();
		expect(result.details?.results).toEqual([]);
	});
});
