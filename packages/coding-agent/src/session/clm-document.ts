import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isClmRewriteMarker } from "@oh-my-pi/pi-agent-core/compaction/messages";
import { isUserTurnInitiator } from "@oh-my-pi/pi-tui/chat/messages";
import { isRecord } from "@oh-my-pi/pi-utils";
import { CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE, createClmNoteMessage, isClmProtectedControl } from "./clm-state";
import { bashExecutionToText, pythonExecutionToText } from "./messages";

/** Why a block is pinned; named in rejections so the model can restore exactly what it dropped. */
export type ClmProtectedKind = "current request" | "live exchange" | "host control";

/** Host payload never crosses the editable document boundary. */
export interface ClmDocumentBlock {
	/** Envelope-scoped id (`b<start>`); the envelope `snapshotId` carries snapshot identity. */
	readonly id: string;
	/** Role of the block's opening message; host-owned and read-only. */
	readonly role: AgentMessage["role"];
	readonly text: string;
	readonly protected: boolean;
	readonly protectedKind?: ClmProtectedKind;
	readonly opaque: boolean;
	/** Message range, including hidden rewrite markers that precede the opening message. */
	readonly start: number;
	readonly end: number;
}

export interface ClmDocumentSnapshot {
	readonly text: string;
	readonly messages: AgentMessage[];
	readonly revision: string;
	readonly snapshotId: string;
	readonly blocks: readonly ClmDocumentBlock[];
}

export interface ClmDocumentOptions {
	revision: string;
	snapshotId: string;
	/** Messages pinned like the current human initiator (e.g. the prompt that started the run). */
	protectedIndexes?: ReadonlySet<number>;
}

const DOCUMENT_FORMAT = "omp-clm";
const DOCUMENT_VERSION = 2;

/** Render only inspectable content, never executable metadata or hidden provider replay state. */
function displayMessage(message: AgentMessage): { text: string; opaque: boolean } {
	const record = message as unknown as Record<string, unknown>;
	let content = record.content;
	// Native replay state includes recorded request controls as well as opaque payloads.
	let opaque = record.providerPayload !== undefined || record.requestControls !== undefined;
	switch (message.role) {
		case "branchSummary":
			content = message.summary;
			break;
		case "compactionSummary":
			content = [{ type: "text", text: message.summary }, ...(message.blocks ?? message.images ?? [])];
			break;
		case "bashExecution":
			if (!message.excludeFromContext) {
				content = [{ type: "text", text: bashExecutionToText(message) }, ...(message.images ?? [])];
			}
			break;
		case "pythonExecution":
			if (!message.excludeFromContext) content = pythonExecutionToText(message);
			break;
		case "fileMention":
			content = message.files.flatMap(file => [
				{ type: "text", text: `${file.path}\n${file.content}` },
				...(file.image ? [file.image] : []),
			]);
			break;
	}
	let text: string;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.map((block: unknown) => {
				if (isRecord(block)) {
					// Signatures bind the visible text to hidden provider state: readable, but never partially rewritable.
					if (block.type === "text" && typeof block.text === "string") {
						opaque ||= typeof block.textSignature === "string" && block.textSignature !== "";
						return block.text;
					}
					if (block.type === "thinking" && typeof block.thinking === "string") {
						opaque ||= typeof block.thinkingSignature === "string" && block.thinkingSignature !== "";
						return block.thinking;
					}
					if (block.type === "toolCall" && typeof block.name === "string") {
						opaque ||= typeof block.thoughtSignature === "string" && block.thoughtSignature !== "";
						return `${block.name}(${JSON.stringify(block.arguments)})`;
					}
				}
				opaque = true;
				return "[Opaque host payload: retain this block unchanged or delete the complete block.]";
			})
			.join("\n");
	} else {
		opaque = true;
		text = "[Opaque host message: retain unchanged or delete the complete block.]";
	}
	return { text, opaque };
}

/** Build atomic assistant/tool exchanges and pin the current initiator and live tail. */
export function createClmDocument(messages: AgentMessage[], options: ClmDocumentOptions): ClmDocumentSnapshot {
	// A regenerated index is data after the live tail, not a reason to unpin that exchange.
	let liveEnd = messages.length;
	while (liveEnd > 0) {
		const tail = messages[liveEnd - 1];
		if (tail.role !== "custom" || tail.customType !== CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE) break;
		liveEnd--;
	}
	let currentInitiator = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			(message.role === "user" && message.attribution !== "agent") ||
			(message.role === "custom" && isUserTurnInitiator(message))
		) {
			currentInitiator = i;
			break;
		}
	}
	const blocks: ClmDocumentBlock[] = [];
	for (let start = 0; start < messages.length;) {
		// Rewrite markers carry no text: they ride hidden with the block they precede and leave with it.
		let first = start;
		while (first < messages.length && isClmRewriteMarker(messages[first])) first++;
		if (first === messages.length) break;
		const opening = messages[first];
		let end = first + 1;
		let live = false;
		if (opening.role === "toolResult") throw new Error("CLM cannot snapshot an orphan tool result");
		if (opening.role === "assistant") {
			const calls = opening.content.filter(block => block.type === "toolCall");
			const pending = new Map(calls.map(call => [call.id, call.name]));
			if (pending.size !== calls.length) throw new Error("CLM cannot snapshot duplicate tool call IDs");
			while (end < messages.length && messages[end].role === "toolResult") {
				const result = messages[end];
				if (result.role !== "toolResult") break;
				if (pending.get(result.toolCallId) !== result.toolName)
					throw new Error("CLM cannot snapshot mismatched tool results");
				pending.delete(result.toolCallId);
				end++;
			}
			if (pending.size > 0) {
				if (end !== messages.length) throw new Error("CLM cannot snapshot an incomplete historical tool exchange");
				live = true;
			}
			if (end === liveEnd) live = true;
		}
		let protectedKind: ClmProtectedKind | undefined = live ? "live exchange" : undefined;
		let opaque = false;
		const parts: string[] = [];
		for (let i = first; i < end; i++) {
			const message = messages[i];
			if (protectedKind === undefined) {
				if (i === currentInitiator || options.protectedIndexes?.has(i) === true) protectedKind = "current request";
				else if (isClmProtectedControl(message)) protectedKind = "host control";
			}
			const rendered = displayMessage(message);
			// The block role names the opening message; results inside an exchange name their tool.
			parts.push(
				message.role === "toolResult"
					? `[toolResult ${message.toolName}${message.isError ? " error" : ""}]\n${rendered.text}`
					: rendered.text,
			);
			opaque ||= rendered.opaque;
		}
		blocks.push({
			id: `b${start}`,
			role: opening.role,
			text: parts.join("\n\n"),
			protected: protectedKind !== undefined,
			protectedKind,
			opaque,
			start,
			end,
		});
		start = end;
	}
	// One block per line keeps the envelope cheap to read and diff; flags appear only when set.
	const lines = blocks.map(block =>
		JSON.stringify({
			id: block.id,
			role: block.role,
			...(block.protected ? { protected: true } : {}),
			...(block.opaque ? { opaque: true } : {}),
			text: block.text,
		}),
	);
	const head = JSON.stringify({
		format: DOCUMENT_FORMAT,
		version: DOCUMENT_VERSION,
		revision: options.revision,
		snapshotId: options.snapshotId,
	});
	const text = `${head.slice(0, -1)},"blocks":[${lines.length > 0 ? `\n${lines.join(",\n")}\n` : ""}],"end":"${DOCUMENT_FORMAT}"}`;
	return { text, messages, revision: options.revision, snapshotId: options.snapshotId, blocks };
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key));
}

function describeBlock(block: ClmDocumentBlock): string {
	return block.protectedKind === undefined ? block.id : `${block.id} (${block.protectedKind})`;
}

/** Compile arbitrary text transformations without manufacturing native roles, calls, or signatures. */
export function applyClmDocument(
	content: string,
	snapshot: ClmDocumentSnapshot,
	timestamp = Date.now(),
): { messages: AgentMessage[]; changed: boolean } {
	if (content === snapshot.text) return { messages: snapshot.messages, changed: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("CLM requires a complete, untruncated JSON document");
	}
	if (
		!isRecord(parsed) ||
		!exactKeys(parsed, ["format", "version", "revision", "snapshotId", "blocks", "end"]) ||
		parsed.format !== DOCUMENT_FORMAT ||
		parsed.version !== DOCUMENT_VERSION ||
		parsed.end !== DOCUMENT_FORMAT ||
		!Array.isArray(parsed.blocks)
	) {
		throw new Error("Invalid or incomplete CLM document framing");
	}
	if (parsed.revision !== snapshot.revision || parsed.snapshotId !== snapshot.snapshotId)
		throw new Error("Stale or foreign CLM document snapshot");
	const source = new Map(snapshot.blocks.map(block => [block.id, block]));
	const seen = new Set<string>();
	const entries: Array<{ block?: ClmDocumentBlock; text: string }> = [];
	for (const value of parsed.blocks) {
		if (!isRecord(value) || typeof value.text !== "string") throw new Error("Malformed CLM text block");
		if (value.id === undefined) {
			if (!exactKeys(value, ["text"]))
				throw new Error("New CLM blocks contain only text; roles and metadata are host-owned");
			if (value.text.trim() === "") throw new Error("Empty CLM note; delete the block instead");
			entries.push({ text: value.text });
			continue;
		}
		if (typeof value.id !== "string") throw new Error("Malformed CLM block ID");
		const block = source.get(value.id);
		if (!block || seen.has(value.id)) throw new Error(`Duplicate or foreign CLM block ID: ${value.id}`);
		seen.add(value.id);
		const keys = ["id", "role", "text"];
		if (block.protected) keys.push("protected");
		if (block.opaque) keys.push("opaque");
		if (
			!exactKeys(value, keys) ||
			value.role !== block.role ||
			(block.protected && value.protected !== true) ||
			(block.opaque && value.opaque !== true)
		) {
			throw new Error(`CLM block ${block.id} metadata (role, protected, opaque) is host-owned; copy it unchanged`);
		}
		entries.push({ block, text: value.text });
	}
	const protectedBlocks = snapshot.blocks.filter(block => block.protected);
	const missing = protectedBlocks.filter(block => !seen.has(block.id));
	if (missing.length > 0) {
		throw new Error(
			`Protected CLM blocks cannot be deleted: ${missing.map(describeBlock).join(", ")}. Copy protected blocks verbatim and in order; unprotected blocks may be deleted freely.`,
		);
	}
	let region = 0;
	const sourceRegions = new Map<string, number>();
	for (const block of snapshot.blocks) {
		sourceRegions.set(block.id, region);
		if (block.protected) region++;
	}
	region = 0;
	let protectedIndex = 0;
	const candidate: Array<{ block?: ClmDocumentBlock; text: string }> = [];
	for (const entry of entries) {
		const block = entry.block;
		if (block?.protected) {
			if (protectedBlocks[protectedIndex++] !== block)
				throw new Error(
					`Protected CLM block ${describeBlock(block)} was reordered; keep protected blocks in order`,
				);
			if (entry.text !== block.text)
				throw new Error(`Protected CLM block ${describeBlock(block)} cannot be changed; copy its text verbatim`);
			region++;
		} else if (block) {
			// Only a changed blank text means deletion; untouched empty native payloads must survive.
			if (entry.text !== block.text && entry.text.trim() === "") continue;
			if (sourceRegions.get(block.id) !== region)
				throw new Error(`CLM block ${block.id} cannot cross a protected interaction boundary`);
			if (block.opaque && entry.text !== block.text)
				throw new Error(
					`Opaque CLM block ${block.id} cannot be rewritten; retain it unchanged or delete the whole block and add a new note`,
				);
		}
		candidate.push(entry);
	}
	const tail = snapshot.blocks.at(-1);
	if (tail?.protectedKind === "live exchange" && candidate.at(-1)?.block !== tail) {
		let first = tail.start;
		while (isClmRewriteMarker(snapshot.messages[first])) first++;
		const opening = snapshot.messages[first];
		if (opening.role === "assistant") {
			const calls = opening.content.reduce((count, block) => count + (block.type === "toolCall" ? 1 : 0), 0);
			if (calls > tail.end - first - 1) {
				// Pending results must stay adjacent to their calls, so nothing may follow an incomplete exchange.
				// Entries after it can only be new notes (existing blocks cannot cross a protected boundary):
				// move the exchange back to the end, which places those notes just before it.
				const at = candidate.findIndex(entry => entry.block === tail);
				candidate.push(...candidate.splice(at, 1));
			}
		}
	}
	const messages: AgentMessage[] = [];
	for (const { block, text } of candidate) {
		if (block && block.text === text) {
			for (let i = block.start; i < block.end; i++) messages.push(snapshot.messages[i]);
		} else {
			messages.push(createClmNoteMessage(text, timestamp));
		}
	}
	// Trailing rewrite markers belong to no block; keep them so a reformatted no-op stays a no-op.
	for (let i = tail?.end ?? 0; i < snapshot.messages.length; i++) messages.push(snapshot.messages[i]);
	if (
		messages.length === snapshot.messages.length &&
		messages.every((message, i) => message === snapshot.messages[i])
	) {
		return { messages: snapshot.messages, changed: false };
	}
	return { messages, changed: true };
}
