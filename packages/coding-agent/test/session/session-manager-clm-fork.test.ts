import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { applyClmDocument, createClmDocument } from "../../src/session/clm-document";
import { assertClmMessages, createClmNoteMessage, createClmRewriteMessage } from "../../src/session/clm-state";
import { SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "../../src/session/session-storage";

function usage(): Usage {
	return {
		input: 100,
		output: 20,
		cacheRead: 10,
		cacheWrite: 0,
		totalTokens: 130,
		cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 0, total: 4 },
		premiumRequests: 2,
		credits: { cost: 4, committedCost: 4, acuCost: 2 },
	};
}

function call(id: string): AssistantMessage {
	return {
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "fork",
		stopReason: "toolUse",
		timestamp: 2,
		content: [{ type: "toolCall", id, name: "task", arguments: { agent: "worker" } }],
		usage: usage(),
	};
}

class GatedStorage extends MemorySessionStorage {
	readonly started = Promise.withResolvers<void>();
	readonly release = Promise.withResolvers<void>();
	pauseNext = false;
	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.pauseNext) {
			this.pauseNext = false;
			this.started.resolve();
			await this.release.promise;
		}
		await super.writeTextAtomic(path, content, options);
	}
}

describe("CLM session forks", () => {
	it("does not mistake a previous exchange result for completion of a reused call ID", async () => {
		const storage = new MemorySessionStorage();
		const parent = SessionManager.create("/repo", "/parent", storage);
		parent.appendMessage({ role: "user", content: "previous assignment", timestamp: 1 });
		parent.appendMessage(call("reused"));
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "reused",
			toolName: "task",
			timestamp: 3,
			isError: false,
			content: [{ type: "text", text: "previous result" }],
		});
		const boundary = parent.appendMessage({ role: "user", content: "current assignment", timestamp: 4 });
		const pending = parent.appendMessage(call("reused"));
		await parent.ensureOnDisk();
		await parent.flush();
		const fork = await SessionManager.forkFrom(parent.getSessionFile()!, "/repo", "/child", storage, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			excludeInFlightTurn: true,
		});
		expect(fork.getEntry(pending)).toBeUndefined();
		expect(fork.getLeafId()).toBe(boundary);
		assertClmMessages(fork.buildSessionContext().messages, false);
		await fork.close();
		await parent.close();
	});

	it("keeps a completed projection that supersedes an unresolved raw assistant", async () => {
		const storage = new MemorySessionStorage();
		const parent = SessionManager.create("/repo", "/parent", storage);
		parent.appendMessage({ role: "user", content: "obsolete raw requirement", timestamp: 1 });
		const obsolete = parent.appendMessage(call("obsolete"));
		const projection = parent.appendContextProjection({
			coveredThroughEntryId: obsolete,
			messages: [createClmRewriteMessage(4), createClmNoteMessage("current memory", 4)],
			rewriteAt: 4,
			tokensBefore: 100,
			tokensAfter: 5,
			cause: "compact",
		});
		await parent.ensureOnDisk();
		await parent.flush();
		const fork = await SessionManager.forkFrom(parent.getSessionFile()!, "/repo", "/child", storage, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			excludeInFlightTurn: true,
		});
		expect(fork.getLatestContextProjection()?.id).toBe(projection);
		expect(fork.buildSessionContext().messages).toEqual([
			createClmRewriteMessage(4),
			createClmNoteMessage("current memory", 4),
		]);
		const reopened = await SessionManager.open(fork.getSessionFile()!, "/child", storage);
		expect(reopened.buildSessionContext().messages).toEqual(fork.buildSessionContext().messages);
		await reopened.close();
		await fork.close();
		await parent.close();
	});

	it("persists the cutoff branch when another retained branch was appended later", async () => {
		const storage = new MemorySessionStorage();
		const parent = SessionManager.create("/repo", "/parent", storage);
		const root = parent.appendMessage({ role: "user", content: "active requirement", timestamp: 1 });
		const pending = parent.appendMessage(call("active-task"));
		parent.branch(root);
		const sibling = parent.appendMessage({ role: "user", content: "sibling requirement", timestamp: 3 });
		parent.branch(pending);
		parent.appendModelChange("mock/dropped-model");
		await parent.ensureOnDisk();
		await parent.flush();
		const fork = await SessionManager.forkFrom(parent.getSessionFile()!, "/repo", "/child", storage, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			excludeInFlightTurn: true,
		});
		expect(fork.getEntry(sibling)).toBeDefined();
		expect(fork.buildSessionContext().messages).toEqual([
			{ role: "user", content: "active requirement", timestamp: 1 },
		]);
		const reopened = await SessionManager.open(fork.getSessionFile()!, "/child", storage);
		expect(reopened.buildSessionContext().messages).toEqual(fork.buildSessionContext().messages);
		const assignment = reopened.appendMessage({ role: "user", content: "child assignment", timestamp: 4 });
		expect(reopened.getBranch(assignment).some(entry => entry.id === sibling)).toBe(false);
		await reopened.close();
		await fork.close();
		await parent.close();
	});

	it("cuts mixed completed and pending calls identically for two children, including descendant metadata", async () => {
		const storage = new MemorySessionStorage();
		const parent = SessionManager.create("/repo", "/parent", storage);
		const root = parent.appendMessage({ role: "user", content: "raw requirement", timestamp: 1 });
		parent.appendLabelChange(root, "retained-label");
		parent.appendModelChange("mock/retained-model");
		const projection = parent.appendContextProjection({
			coveredThroughEntryId: parent.getLeafId(),
			messages: [createClmRewriteMessage(3), createClmNoteMessage("working memory", 3)],
			rewriteAt: 3,
			tokensBefore: 100,
			tokensAfter: 5,
			cause: "edit",
		});
		const expected = parent.buildSessionContext();
		const mixed = call("task-a");
		mixed.content.push(
			{ type: "toolCall", id: "task-b", name: "task", arguments: { agent: "worker" } },
			{ type: "toolCall", id: "read-done", name: "read", arguments: { path: "spec" } },
		);
		const pending = parent.appendMessage(mixed);
		parent.appendMessage({
			role: "toolResult",
			toolCallId: "read-done",
			toolName: "read",
			timestamp: 4,
			isError: false,
			content: [{ type: "text", text: "partial turn result" }],
		});
		parent.appendLabelChange(root, "dropped-label");
		parent.appendLabelChange(pending, "pending-label");
		parent.appendModelChange("mock/dropped-model");
		parent.appendModelUsage(
			{
				purpose: "compaction",
				role: "default",
				api: "mock",
				provider: "mock",
				model: "dropped",
				usage: usage(),
				stopReason: "stop",
			},
			{ sessionId: parent.getSessionId(), parentId: pending },
		);
		await parent.ensureOnDisk();
		await parent.flush();
		const children = await Promise.all(
			["/child-a", "/child-b"].map(dir =>
				SessionManager.forkFrom(parent.getSessionFile()!, "/repo", dir, storage, {
					copyArtifacts: false,
					suppressBreadcrumb: true,
					excludeInFlightTurn: true,
					resetInheritedCost: true,
				}),
			),
		);
		for (const child of children) {
			expect(child.getLeafId()).toBe(projection);
			expect(child.buildSessionContext()).toEqual(expected);
			expect(child.getEntry(pending)).toBeUndefined();
			expect(child.getLabel(root)).toBe("retained-label");
			expect(child.getUsageStatistics().cost).toBe(0);
			expect(child.getEntries().some(entry => entry.type === "model_usage")).toBe(false);
			const reopened = await SessionManager.open(child.getSessionFile()!, undefined, storage);
			expect(reopened.buildSessionContext()).toEqual(expected);
			await reopened.close();
		}
		expect(children[0]!.getSessionFile()).not.toBe(children[1]!.getSessionFile());
		children[0]!.appendMessage({ role: "user", content: "child a assignment", timestamp: 5 });
		expect(children[1]!.getLeafId()).toBe(projection);
		expect(parent.getEntry(pending)).toBeDefined();
		expect(parent.getLabel(root)).toBe("dropped-label");
		expect(parent.getUsageStatistics().cost).toBe(8);
		for (const child of children) await child.close();
		await parent.close();
	});

	it("inherits the projection rather than deleted transcript, repairs the live suffix, and protects the child assignment", async () => {
		using dir = TempDir.createSync("@omp-clm-fork-");
		const parent = SessionManager.create(dir.path(), dir.join("parent"));
		const old = parent.appendMessage({ role: "user", content: "REMOVED_PARENT_NOISE", timestamp: 1 });
		parent.appendContextProjection({
			coveredThroughEntryId: old,
			messages: [createClmNoteMessage("PROJECTED_WORKING_MEMORY", 2)],
			rewriteAt: 3,
			tokensBefore: 20,
			tokensAfter: 5,
			cause: "edit",
		});
		parent.appendMessage(call("active-task"));
		await parent.ensureOnDisk();
		await parent.flush();
		const fork = await SessionManager.forkFrom(parent.getSessionFile()!, dir.path(), dir.join("child"), undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		fork.appendMessage({ role: "user", content: "CURRENT_CHILD_ASSIGNMENT", timestamp: 4 });
		const messages = fork.buildSessionContext().messages;
		assertClmMessages(messages, false);
		expect(JSON.stringify(messages)).toContain("PROJECTED_WORKING_MEMORY");
		expect(JSON.stringify(messages)).not.toContain("REMOVED_PARENT_NOISE");
		const aborted = messages.find(message => message.role === "toolResult");
		expect(aborted).toMatchObject({ role: "toolResult", toolCallId: "active-task", isError: true });
		const snapshot = createClmDocument(messages, { revision: "fork", snapshotId: "child" });
		const doc = JSON.parse(snapshot.text);
		const assignment = doc.blocks.find((block: { text: string }) => block.text.includes("CURRENT_CHILD_ASSIGNMENT"));
		expect(assignment.protected).toBe(true);
		doc.blocks = doc.blocks.filter((block: { text: string }) => !block.text.includes("CURRENT_CHILD_ASSIGNMENT"));
		expect(() => applyClmDocument(JSON.stringify(doc), snapshot, 5)).toThrow(/protected/i);
		await fork.close();
		await parent.close();
	});

	it("resets projected assistant and task billing without changing tokens or parent spend", async () => {
		using dir = TempDir.createSync("@omp-clm-fork-billing-");
		const parent = SessionManager.create(dir.path(), dir.join("parent"));
		const root = parent.appendMessage({ role: "user", content: "PARENT_REQUIREMENT", timestamp: 1 });
		const projected: AgentMessage[] = [
			call("completed-task"),
			{
				role: "toolResult",
				toolCallId: "completed-task",
				toolName: "task",
				timestamp: 3,
				isError: false,
				content: [{ type: "text", text: "CHILD_RESULT" }],
				details: { usage: usage() },
			},
		];
		parent.appendContextProjection({
			coveredThroughEntryId: root,
			messages: projected,
			rewriteAt: 4,
			tokensBefore: 100,
			tokensAfter: 30,
			cause: "edit",
		});
		await parent.ensureOnDisk();
		await parent.flush();
		const fork = await SessionManager.forkFrom(parent.getSessionFile()!, dir.path(), dir.join("child"), undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			resetInheritedCost: true,
		});
		const effective = fork.buildSessionContext().messages;
		const assistant = effective.find((message): message is AssistantMessage => message.role === "assistant")!;
		expect(assistant.usage).toMatchObject({
			input: 100,
			output: 20,
			cacheRead: 10,
			totalTokens: 130,
			cost: { total: 0 },
		});
		expect(assistant.usage.credits).toBeUndefined();
		expect(assistant.usage.premiumRequests).toBeUndefined();
		const result = effective.find(message => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("Missing projected task result");
		expect(result.details).toMatchObject({ usage: { totalTokens: 130, cost: { total: 0 } } });
		const original = parent
			.buildSessionContext()
			.messages.find((message): message is AssistantMessage => message.role === "assistant")!;
		expect(original.usage.cost.total).toBe(4);
		await fork.close();
		await parent.close();
	});

	it("flushes a gated journal rewrite and intervening task call before reading the fork", async () => {
		const storage = new GatedStorage();
		const parent = SessionManager.create("/repo", "/parent", storage);
		parent.appendMessage({ role: "user", content: "PARENT_REQUIREMENT", timestamp: 1 });
		storage.pauseNext = true;
		const persisted = parent.ensureOnDisk();
		await storage.started.promise;
		parent.appendMessage(call("race-task"));
		const flush = parent.flush();
		storage.release.resolve();
		await persisted;
		await flush;
		const fork = await SessionManager.forkFrom(parent.getSessionFile()!, "/repo", "/child", storage, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const messages = fork.buildSessionContext().messages;
		assertClmMessages(messages, false);
		expect(messages.find(message => message.role === "assistant")).toMatchObject({
			content: [{ type: "toolCall", id: "race-task", name: "task" }],
		});
		expect(messages.find(message => message.role === "toolResult")).toMatchObject({
			toolCallId: "race-task",
			isError: true,
		});
		await fork.close();
		await parent.close();
	});
});
