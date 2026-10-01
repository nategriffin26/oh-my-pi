import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type ClmNoteMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isUserTurnInitiator } from "@oh-my-pi/pi-tui/chat/messages";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isBlobRef } from "./blob-store";
import { isExternalizableImagePosition } from "./session-persistence";
import type { ContextProjectionEntry, SessionEntry, SessionHeader } from "./session-entries";

export type ContextProjectionInput = Omit<ContextProjectionEntry, "type" | "version" | "id" | "parentId" | "timestamp">;

/** Custom type of host CLM feedback (pressure, receipts, rejections); editable so stale feedback can be deleted. */
export const CLM_FEEDBACK_MESSAGE_TYPE = "clm-feedback";

/** Regenerated archive index; editable historical data, excluded from the archive itself. */
export const CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE = "clm-out-of-context-index";

/** Custom type of a parent's task handoff seed in a child; editable so the child can drop it once absorbed. */
export const CLM_HANDOFF_MESSAGE_TYPE = "clm-handoff";

/** Protected parent archive index; its content lowers as historical data, never developer authority. */
export const CLM_PARENT_MANIFEST_MESSAGE_TYPE = "clm-parent-manifest";

/** Host-authored custom messages the model may rewrite or delete through context://self. */
const CLM_EDITABLE_CUSTOM_TYPES: Record<string, true> = {
	[CLM_FEEDBACK_MESSAGE_TYPE]: true,
	[CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE]: true,
	[CLM_HANDOFF_MESSAGE_TYPE]: true,
};

/** Every assistant content type is snapshot-valid; a new provider block type must be added here to typecheck. */
const ASSISTANT_CONTENT_TYPES = {
	text: true,
	thinking: true,
	redactedThinking: true,
	fallback: true,
	anthropicServerTool: true,
	image: true,
	toolCall: true,
} as const satisfies Record<AssistantMessage["content"][number]["type"], true>;

/** Host custom/hook messages normally lower to developer authority; historical user initiators are data. */
export function isClmProtectedControl(message: AgentMessage): boolean {
	return (
		message.role === "developer" ||
		message.role === "hookMessage" ||
		(message.role === "custom" &&
			!Object.hasOwn(CLM_EDITABLE_CUSTOM_TYPES, message.customType) &&
			!isUserTurnInitiator(message))
	);
}

export function validateSessionRequirements(header: SessionHeader): void {
	const requirements = header.requiredFeatures;
	if (requirements === undefined) return;
	if (!isRecord(requirements)) throw new Error("Malformed session feature requirements");
	for (const [feature, version] of Object.entries(requirements)) {
		if (
			(feature !== "contextProjection" &&
				feature !== "contextProjectionStrings" &&
				feature !== "managedDiagnostics") ||
			version !== 1
		) {
			throw new Error(`Unsupported required session feature: ${feature}@${String(version)}`);
		}
	}
}

export function createClmNoteMessage(text: string, timestamp: number): ClmNoteMessage {
	return { role: "clmNote", content: text, timestamp };
}

/** A zero-text note still carries a deletion-only rewrite through provider conversion. */
export function createClmRewriteMessage(rewriteAt: number): ClmNoteMessage {
	return { ...createClmNoteMessage("", rewriteAt), historyRewriteAt: rewriteAt };
}

export function getLatestContextProjectionEntry(entries: readonly SessionEntry[]): ContextProjectionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "context_projection") return entry;
		if (entry.type === "reset_boundary" || entry.type === "compaction") return null;
	}
	return null;
}

export function getContextProjectionMessages(entry: ContextProjectionEntry): AgentMessage[] {
	validateContextProjection(entry);
	assertHydratedProjectionImages(entry.messages);
	if (entry.messages.some(message => message.role === "clmNote" && message.historyRewriteAt === entry.rewriteAt)) {
		return [...entry.messages];
	}
	return [createClmRewriteMessage(entry.rewriteAt), ...entry.messages];
}

/** Reject bad snapshots instead of falling back to the original execution history. */
export function validateContextProjection(value: unknown): asserts value is ContextProjectionEntry {
	if (!isRecord(value) || value.type !== "context_projection" || value.version !== 1) {
		throw new Error("Unsupported CLM context projection version");
	}
	if (
		typeof value.id !== "string" ||
		!value.id ||
		!(value.parentId === null || typeof value.parentId === "string") ||
		typeof value.timestamp !== "string" ||
		!Number.isFinite(Date.parse(value.timestamp)) ||
		!(value.previousRevisionId === undefined || typeof value.previousRevisionId === "string") ||
		!(value.coveredThroughEntryId === null || typeof value.coveredThroughEntryId === "string") ||
		!Array.isArray(value.messages) ||
		typeof value.rewriteAt !== "number" ||
		!Number.isFinite(value.rewriteAt) ||
		typeof value.tokensBefore !== "number" ||
		!Number.isFinite(value.tokensBefore) ||
		value.tokensBefore < 0 ||
		typeof value.tokensAfter !== "number" ||
		!Number.isFinite(value.tokensAfter) ||
		value.tokensAfter < 0 ||
		!["edit", "restore", "rebase", "compact", "diagnostics", "spill"].includes(String(value.cause))
	)
		throw new Error("Malformed CLM context projection");
	assertClmMessages(value.messages as AgentMessage[], false);
}

/** Structural pairing gate; persistence-truncated strings are data the journal already carries, not malformation. */
export function assertClmMessages(messages: readonly AgentMessage[], allowIncompleteTail = true): void {
	const pending = new Map<string, string>();
	for (const message of messages) {
		validateSnapshotMessage(message);
		if (message.role === "toolResult") {
			if (pending.get(message.toolCallId) !== message.toolName)
				throw new Error("CLM snapshot has an orphan or mismatched tool result");
			pending.delete(message.toolCallId);
			continue;
		}
		if (pending.size > 0) throw new Error("CLM snapshot interleaves an incomplete native tool exchange");
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (pending.has(block.id)) throw new Error("CLM snapshot has duplicate native tool call IDs");
				pending.set(block.id, block.name);
			}
		}
	}
	if (!allowIncompleteTail && pending.size > 0)
		throw new Error("CLM projection has an incomplete native tool exchange");
}

function validateSnapshotMessage(message: unknown): void {
	if (!isRecord(message) || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
		throw new Error("Malformed CLM snapshot message");
	}
	const content = message.content;
	switch (message.role) {
		case "clmNote":
			if (
				typeof content !== "string" ||
				(message.historyRewriteAt !== undefined &&
					(typeof message.historyRewriteAt !== "number" || !Number.isFinite(message.historyRewriteAt)))
			) {
				throw new Error("Malformed CLM note");
			}
			break;
		case "user":
		case "developer":
		case "custom":
		case "hookMessage":
			if (!(typeof content === "string" || Array.isArray(content)))
				throw new Error("Malformed CLM snapshot content");
			break;
		case "assistant":
			if (
				!Array.isArray(content) ||
				typeof message.api !== "string" ||
				typeof message.provider !== "string" ||
				typeof message.model !== "string" ||
				typeof message.stopReason !== "string" ||
				!isRecord(message.usage)
			) {
				throw new Error("Malformed CLM snapshot assistant");
			}
			break;
		case "toolResult":
			if (
				!Array.isArray(content) ||
				typeof message.toolCallId !== "string" ||
				typeof message.toolName !== "string" ||
				typeof message.isError !== "boolean"
			)
				throw new Error("Malformed CLM snapshot tool result");
			break;
		case "compactionSummary":
		case "branchSummary":
			if (typeof message.summary !== "string") throw new Error("Malformed CLM snapshot summary");
			break;
		case "bashExecution":
		case "pythonExecution":
			if (typeof message.output !== "string") throw new Error("Malformed CLM snapshot execution");
			break;
		case "fileMention":
			if (
				!Array.isArray(message.files) ||
				message.files.some(
					file => !isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string",
				)
			)
				throw new Error("Malformed CLM file mention");
			break;
		default:
			throw new Error("Unsupported CLM snapshot message role");
	}
	if (message.images !== undefined) {
		if (!Array.isArray(message.images)) throw new Error("Malformed CLM snapshot images");
		for (const image of message.images) validateSnapshotImage(image);
	}
	if (message.blocks !== undefined) {
		if (!Array.isArray(message.blocks)) throw new Error("Malformed CLM snapshot archive blocks");
		for (const block of message.blocks) {
			if (isRecord(block) && block.type === "text" && typeof block.text === "string") continue;
			validateSnapshotImage(block);
		}
	}
	if (message.role === "fileMention" && Array.isArray(message.files)) {
		for (const file of message.files) {
			if (isRecord(file) && file.image !== undefined) validateSnapshotImage(file.image);
		}
	}
	if (Array.isArray(content)) {
		for (const block of content) {
			if (
				!isRecord(block) ||
				typeof block.type !== "string" ||
				!Object.hasOwn(ASSISTANT_CONTENT_TYPES, block.type) ||
				(message.role !== "assistant" && block.type !== "text" && block.type !== "image") ||
				(block.type === "text" && typeof block.text !== "string") ||
				(block.type === "image" && (typeof block.data !== "string" || typeof block.mimeType !== "string")) ||
				(block.type === "thinking" && typeof block.thinking !== "string") ||
				(block.type === "redactedThinking" && typeof block.data !== "string") ||
				(block.type === "fallback" &&
					(!isRecord(block.from) ||
						typeof block.from.model !== "string" ||
						!isRecord(block.to) ||
						typeof block.to.model !== "string")) ||
				(block.type === "anthropicServerTool" && !isRecord(block.block)) ||
				(block.type === "toolCall" &&
					(typeof block.id !== "string" || typeof block.name !== "string" || !isRecord(block.arguments)))
			) {
				throw new Error("Malformed CLM snapshot content block");
			}
		}
	}
	const payload = message.providerPayload;
	if (payload !== undefined) {
		if (!isRecord(payload)) throw new Error("Malformed CLM provider payload");
		if (
			payload.type === "anthropicCompaction" ||
			(payload.type === "openaiResponsesHistory" && payload.dt !== true)
		) {
			throw new Error("CLM projections require a readable rebase of opaque whole-history payloads");
		}
		if (payload.type === "openaiResponsesHistory") {
			if (
				message.role !== "assistant" ||
				!Array.isArray(payload.items) ||
				payload.items.some(item => !isRecord(item)) ||
				(payload.provider !== undefined && typeof payload.provider !== "string")
			)
				throw new Error("Malformed CLM delta history payload");
		} else if (payload.type === "anthropicMessage") {
			if (
				(payload.clearAt !== undefined && payload.clearAt !== "never" && payload.clearAt !== "next_user_message") ||
				(payload.effort !== undefined &&
					!["low", "medium", "high", "xhigh", "max"].includes(String(payload.effort))) ||
				(payload.toolChanges !== undefined &&
					(!Array.isArray(payload.toolChanges) ||
						payload.toolChanges.some(
							change =>
								!isRecord(change) ||
								typeof change.name !== "string" ||
								(change.type !== "tool_addition" && change.type !== "tool_removal"),
						)))
			) {
				throw new Error("Malformed CLM Anthropic message payload");
			}
		} else {
			throw new Error("Unsupported CLM provider payload type");
		}
	}
}

function assertHydratedProjectionImages(value: unknown, key?: string): void {
	if (isExternalizableImagePosition(value, key) && isBlobRef(value.data)) {
		throw new Error("CLM projection image blob has not been hydrated");
	}
	if (
		isRecord(value) &&
		((typeof value.image_url === "string" && isBlobRef(value.image_url)) ||
			(value.type === "image_generation_call" && typeof value.result === "string" && isBlobRef(value.result)))
	) {
		throw new Error("CLM projection provider image blob has not been hydrated");
	}
	if (Array.isArray(value)) {
		for (const child of value) assertHydratedProjectionImages(child, key);
	} else if (isRecord(value)) {
		for (const [childKey, child] of Object.entries(value)) assertHydratedProjectionImages(child, childKey);
	}
}

/** Clone at the ownership boundary; later source-row mutations cannot change this revision. */
export function ownContextProjection(entry: ContextProjectionEntry): ContextProjectionEntry {
	validateContextProjection(entry);
	assertHydratedProjectionImages(entry.messages);
	const owned = structuredClone(entry);
	freezeSnapshot(owned);
	return owned;
}

export function freezeSnapshot(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeSnapshot(child);
	Object.freeze(value);
}

function validateSnapshotImage(value: unknown): void {
	if (
		!isRecord(value) ||
		value.type !== "image" ||
		typeof value.data !== "string" ||
		typeof value.mimeType !== "string"
	) {
		throw new Error("Malformed CLM snapshot image");
	}
}
