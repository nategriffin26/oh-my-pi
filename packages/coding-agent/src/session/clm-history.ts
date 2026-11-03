import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ClmNoteMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import { customMessageEntryMessage } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { clmOccurrenceKey } from "./clm-archive";
import {
	CLM_FEEDBACK_MESSAGE_TYPE,
	CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE,
	getContextProjectionMessages,
} from "./clm-state";
import { createBranchSummaryMessage } from "./messages";
import { buildSessionContext } from "./session-context";
import type { ContextProjectionEntry, SessionEntry } from "./session-entries";

/** The same message across revisions: model notes by text, everything else by journal occurrence. */
export function clmMessageKey(message: AgentMessage): string {
	if (message.role === "user" || message.role === "developer") {
		// Journal persistence allows distinct human inputs in the same millisecond.
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		return `${clmOccurrenceKey(message)}:${Bun.hash(content).toString(16)}`;
	}
	return message.role === "clmNote" ? `clmNote:${message.content}` : clmOccurrenceKey(message);
}

/** What a revision dropped and added relative to the context it replaced. */
export interface ClmContextChange {
	/** Messages of the replaced context that are gone: deleted, or collapsed into a note. Host bookkeeping excluded. */
	removed: AgentMessage[];
	/** Model notes whose text is new in this revision. */
	notes: ClmNoteMessage[];
}

/**
 * Diff two contexts by message identity, not content: a spilled result or a retired diagnostic
 * replaces a message in place and is not a removal.
 */
export function diffClmContexts(before: readonly AgentMessage[], after: readonly AgentMessage[]): ClmContextChange {
	const beforeKeys = new Set(before.map(clmMessageKey));
	const afterKeys = new Set(after.map(clmMessageKey));
	return {
		removed: before.filter(
			message =>
				!afterKeys.has(clmMessageKey(message)) &&
				// Rewrite markers, the regenerated index, and host feedback are not what the model edited.
				!(message.role === "clmNote" && message.content.trim() === "") &&
				!(
					(message.role === "custom" || message.role === "hookMessage") &&
					(message.customType === CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE ||
						message.customType === CLM_FEEDBACK_MESSAGE_TYPE)
				),
		),
		notes: after.filter(
			(message): message is ClmNoteMessage =>
				message.role === "clmNote" && message.content.trim() !== "" && !beforeKeys.has(clmMessageKey(message)),
		),
	};
}

/** One committed revision and its change. */
export interface ClmRevisionChange extends ClmContextChange {
	revision: ContextProjectionEntry;
	/** Revision or boundary this one replaced; `root` when the branch had none. */
	previousRevision: string;
}

/** CLM revisions on a branch, as the transcript presents them. */
export interface ClmHistory {
	change(revisionId: string): ClmRevisionChange | undefined;
	/**
	 * The latest revision that took this journal message out of the model's current context;
	 * undefined while it is in context or when no CLM revision removed it (e.g. legacy compaction).
	 */
	removedBy(message: AgentMessage): ContextProjectionEntry | undefined;
}

function journalMessages(branch: readonly SessionEntry[], from: number, to: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = from; index < to; index++) {
		const entry = branch[index];
		if (entry.type === "message") messages.push(entry.message);
		else if (entry.type === "custom_message") {
			const message = customMessageEntryMessage(entry);
			if (message) messages.push(message);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		}
	}
	return messages;
}

/**
 * Replay the CLM revisions after the branch's last reset. Each revision is compared with the
 * context it replaced (the previous revision plus journal entries appended before its coverage
 * boundary), so a restore that brings messages back clears their removal. Undefined when the
 * branch has no revision.
 */
export function resolveClmHistory(branch: readonly SessionEntry[]): ClmHistory | undefined {
	const start = branch.findLastIndex(entry => entry.type === "reset_boundary") + 1;
	const positions = new Map(branch.map((entry, index) => [entry.id, index]));
	const changes = new Map<string, ClmRevisionChange>();
	const removedBy = new Map<string, ContextProjectionEntry>();
	let previous: { entry: ContextProjectionEntry; messages: AgentMessage[]; covered: number } | undefined;
	for (let index = start; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "context_projection") continue;
		const covered =
			entry.coveredThroughEntryId === null ? start - 1 : (positions.get(entry.coveredThroughEntryId) ?? index - 1);
		const before = previous
			? [...previous.messages, ...journalMessages(branch, previous.covered + 1, covered + 1)]
			: entry.parentId === null
				? []
				: buildSessionContext(branch as SessionEntry[], entry.parentId).messages;
		const messages = getContextProjectionMessages(entry);
		const change = diffClmContexts(before, messages);
		changes.set(entry.id, {
			...change,
			revision: entry,
			previousRevision:
				previous?.entry.id ??
				branch.slice(0, index).findLast(item => item.type === "compaction" || item.type === "reset_boundary")?.id ??
				"root",
		});
		for (const message of change.removed) removedBy.set(clmMessageKey(message), entry);
		previous = { entry, messages, covered };
	}
	if (!previous) return undefined;
	const current = new Set(
		[...previous.messages, ...journalMessages(branch, previous.covered + 1, branch.length)].map(clmMessageKey),
	);
	return {
		change: revisionId => changes.get(revisionId),
		removedBy: message => {
			const key = clmMessageKey(message);
			return current.has(key) ? undefined : removedBy.get(key);
		},
	};
}
