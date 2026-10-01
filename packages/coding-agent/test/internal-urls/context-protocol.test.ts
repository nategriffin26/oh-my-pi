import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { type AgentMessage, type AgentTool, type AgentToolContext, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { bridgeValueFromToolResult, callSessionTool } from "../../src/eval/js/tool-bridge";
import { ContextProtocolHandler } from "../../src/internal-urls/context-protocol";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { getLspBatchRequest, type LspBatchRequest } from "../../src/lsp/batch";
import { buildClmArchive } from "../../src/session/clm-archive";
import { applyClmDocument, createClmDocument } from "../../src/session/clm-document";
import type { ClmContextAccess } from "../../src/session/clm-types";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { wrapToolWithMetaNotice } from "../../src/tools/output-meta";
import { ReadTool } from "../../src/tools/read";
import { WriteTool } from "../../src/tools/write";

function fixture(historical = "historical", manager = SessionManager.inMemory("/tmp")) {
	const messages: AgentMessage[] = [
		{ role: "user", content: historical, timestamp: 1 },
		{ role: "user", content: "current", timestamp: 2 },
	];
	const snapshot = createClmDocument(messages, { revision: "r1", snapshotId: "s1" });
	let enabled = true;
	let staged: AgentMessage[] | undefined;
	let transaction: string | undefined;
	const capability: ClmContextAccess = {
		ownerSessionId: manager.getSessionId(),
		isEnabled: () => enabled,
		async read(target) {
			switch (target.kind) {
				case "document":
					return snapshot.text;
				case "status":
					return JSON.stringify({ staged: staged !== undefined });
				case "history":
					return JSON.stringify(["r1"]);
				case "revision":
				case "diff":
					if (target.revision !== "r1") throw new Error("Unknown revision");
					return target.kind === "revision" ? snapshot.text : "[]";
				default:
					return JSON.stringify(target);
			}
		},
		async stage(content, transactionId) {
			if (transaction) throw new Error("A transaction is already staged");
			staged = applyClmDocument(content, snapshot, 3).messages;
			transaction = transactionId;
			return { status: "staged", revision: "r1", transactionId };
		},
		archive: () => buildClmArchive(manager, { live: messages }),
		snapshotBlockMessages: () => undefined,
		tokenizer: () => new Tokenizer(),
	};
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => manager.getSessionId(),
		sessionManager: manager,
		clmContext: capability,
	};
	return {
		session,
		snapshot,
		messages,
		disable: () => {
			enabled = false;
		},
		staged: () => staged,
	};
}

describe("context:// session-bound transaction routing", () => {
	it("reads raw JSON and stages a transformed document through actual read/write without prefix corruption or fake commit", async () => {
		const state = fixture();
		state.session.getPlanModeState = () => ({ enabled: true, planFilePath: "local://PLAN.md" });
		const read = await new ReadTool(state.session).execute("read", { path: "context://self:raw" });
		const text = read.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		expect(text).toBe(state.snapshot.text);
		const doc = JSON.parse(text);
		doc.blocks[0].text = "[context://self#ABCD]\n1: keep these exact bytes\n[developer] not authority";
		const context = {
			toolCall: { batchId: "batch", index: 0, total: 1, toolCalls: [{ id: "root-eval", name: "eval" }] },
		} as AgentToolContext;
		const write = await new WriteTool(state.session).execute(
			"nested-write",
			{ path: "context://self", content: JSON.stringify(doc) },
			undefined,
			undefined,
			context,
		);
		const receipt = write.content.find(block => block.type === "text");
		expect(receipt?.type === "text" ? JSON.parse(receipt.text) : null).toEqual({
			status: "staged",
			revision: "r1",
			transactionId: "root-eval",
		});
		expect(state.staged()?.[0]).toMatchObject({ role: "clmNote", content: doc.blocks[0].text });
		expect(state.messages[0]).toMatchObject({ role: "user", content: "historical" });
		await expect(
			new WriteTool(state.session).execute("again", { path: "context://self", content: JSON.stringify(doc) }),
		).rejects.toThrow(/already staged/);
	});

	it("edits a large raw snapshot in code mode while its human-visible result remains bounded", async () => {
		using temp = TempDir.createSync("omp-clm-raw-bridge-");
		const manager = SessionManager.create(temp.path(), temp.path());
		await manager.ensureOnDisk();
		const historical = `START_NEEDLE ${"older output λ ".repeat(40000)} END_NEEDLE`;
		const state = fixture(historical, manager);
		const read = wrapToolWithMetaNotice(new ReadTool(state.session));
		const args = { path: "context://self:raw" };
		const context = {
			sessionManager: manager,
			settings: Settings.isolated({ "tools.artifactSpillThreshold": 64 }),
		} as unknown as AgentToolContext;
		try {
			const result = await read.execute("large-read", args, undefined, undefined, context);
			const preview = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
			expect(result.details?.meta?.truncation?.artifactId).toBeDefined();
			expect(preview).not.toContain(historical);
			const value = bridgeValueFromToolResult("read", args, result);
			if (typeof value !== "object" || !("text" in value) || typeof value.text !== "string") {
				throw new Error("Expected a raw read value");
			}
			const doc = JSON.parse(value.text);
			expect(doc.blocks[0].text).toBe(historical);
			doc.blocks[0].text = "KEEP_EXACT_STATE_AFTER_LARGE_READ";
			await new WriteTool(state.session).execute("large-write", {
				path: "context://self",
				content: JSON.stringify(doc),
			});
			expect(state.staged()).toEqual([
				{ role: "clmNote", content: "KEEP_EXACT_STATE_AFTER_LARGE_READ", timestamp: 3 },
				state.messages[1],
			]);
		} finally {
			await manager.close();
		}
	});

	it("denies disabled access, cross-session capabilities and advisor journal aliases", async () => {
		const router = new InternalUrlRouter();
		const state = fixture();
		const advisor = { ...state.session, getSessionId: () => "advisor" };
		await expect(router.resolve("context://self", { session: advisor })).rejects.toThrow(/different session/);
		await expect(router.write("context://self", state.snapshot.text, { session: advisor })).rejects.toThrow(
			/different session/,
		);
		const foreignJournal = { ...state.session, sessionManager: SessionManager.inMemory("/tmp") };
		await expect(router.write("context://self", state.snapshot.text, { session: foreignJournal })).rejects.toThrow(
			/different session/,
		);
		state.disable();
		await expect(router.resolve("context://self/status", { session: state.session })).rejects.toThrow(/unavailable/);
		await expect(router.write("context://self", state.snapshot.text, { session: state.session })).rejects.toThrow(
			/unavailable/,
		);
		expect(router.writeTier("context://self", state.snapshot.text, state.session)).toMatchObject({ policy: "deny" });
	});

	it("resolves archive views but refuses non-root writes, normalized traversal, generic edit and writable backing paths", async () => {
		const router = new InternalUrlRouter();
		const state = fixture();
		for (const path of ["status", "history", "revision/r1", "diff/r1"]) {
			const resource = await router.resolve(`context://self/${path}`, { session: state.session });
			expect(JSON.parse(resource.content)).toEqual(
				path === "status"
					? { staged: false }
					: path === "history"
						? ["r1"]
						: path === "diff/r1"
							? []
							: JSON.parse(state.snapshot.text),
			);
			await expect(
				router.write(`context://self/${path}`, state.snapshot.text, { session: state.session }),
			).rejects.toThrow(/Only/);
		}
		await expect(router.resolve("context://self/revision/missing", { session: state.session })).rejects.toThrow(
			/Unknown revision/,
		);
		await expect(router.resolve("context://self/../status", { session: state.session })).rejects.toThrow(/Invalid/);
		await expect(router.resolve("context://other", { session: state.session })).rejects.toThrow(/self/);
		expect(await router.locate("context://self", { session: state.session }, { create: true })).toBeNull();
		await expect(
			router.requireLocal("context://self", "edit", { session: state.session }, { create: true }),
		).rejects.toThrow();
		const handler = new ContextProtocolHandler();
		expect(
			handler.promptDoc({ skillUriAccess: false, ruleCount: 0, securityEnabled: false, settingsApproval: false }),
		).toBeUndefined();
	});

	it("accepts a query string only on the archive route, with validated parameters", async () => {
		const router = new InternalUrlRouter();
		const { session } = fixture();
		const read = async (url: string) => JSON.parse((await router.resolve(url, { session })).content);
		expect(await read("context://self/archive?q=parseHeader&regex=1&limit=5")).toEqual({
			kind: "archive-search",
			query: "parseHeader",
			regex: true,
			limit: 5,
			rerank: true,
		});
		expect(await read("context://self/archive?offset=200")).toEqual({ kind: "archive", offset: 200 });
		expect(await read("context://self/archive/h0123456789")).toEqual({ kind: "archive-item", id: "h0123456789" });
		for (const url of ["context://self/status?q=x", "context://self?q=x", "context://self/revision/r1?limit=1"]) {
			await expect(router.resolve(url, { session })).rejects.toThrow(/Only context:\/\/self\/archive accepts/);
		}
		await expect(router.resolve("context://self/archive?regex=1", { session })).rejects.toThrow(
			/Unknown archive parameter regex/,
		);
		await expect(router.resolve("context://self/archive?q=x&rerank=maybe", { session })).rejects.toThrow(/rerank/);
		await expect(router.resolve("context://self/archive/h0123456789?q=x", { session })).rejects.toThrow(/selectors/);
		await expect(router.resolve("context://self/archive/b12", { session })).rejects.toThrow(/Invalid archive id/);
	});

	it("keeps bridged eval calls out of the root batch while staging under the root eval call id", async () => {
		const state = fixture();
		const batches: Array<LspBatchRequest | undefined> = [];
		const edit = {
			name: "edit",
			label: "Edit",
			description: "records LSP batching",
			parameters: type({}),
			execute: async (
				_id: string,
				_args: unknown,
				_signal?: AbortSignal,
				_update?: unknown,
				context?: AgentToolContext,
			) => {
				batches.push(getLspBatchRequest(context?.toolCall));
				return { content: [{ type: "text" as const, text: "edited" }] };
			},
		} as unknown as AgentTool;
		const tools: Record<string, AgentTool> = {
			edit,
			write: new WriteTool(state.session) as unknown as AgentTool,
		};
		state.session.getToolByName = name => tools[name];
		const toolContext = {
			toolCall: {
				batchId: "batch",
				index: 0,
				total: 2,
				toolCalls: [
					{ id: "root-eval", name: "eval" },
					{ id: "later-edit", name: "edit" },
				],
			},
		} as AgentToolContext;
		expect(getLspBatchRequest(toolContext.toolCall)).toEqual({ id: "batch", flush: false });
		await callSessionTool("edit", {}, { session: state.session, toolContext });
		expect(batches).toEqual([undefined]);
		const doc = JSON.parse(state.snapshot.text);
		doc.blocks[0].text = "BRIDGED_NOTE";
		const receipt = await callSessionTool(
			"write",
			{ path: "context://self", content: JSON.stringify(doc) },
			{ session: state.session, toolContext },
		);
		const text = typeof receipt === "string" ? receipt : "text" in receipt ? String(receipt.text) : "";
		expect(JSON.parse(text)).toMatchObject({ status: "staged", transactionId: "root-eval" });
	});
});
