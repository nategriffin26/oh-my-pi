import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ContextInspectorDiff, ContextInspectorSnapshot } from "@oh-my-pi/pi-tui/overlays/context-inspector";
import type { ClmPressureNotice } from "@oh-my-pi/pi-tui/chat/clm-notice";
import type { ClmReadDetails } from "@oh-my-pi/pi-tui/tools/clm-render";
import type { ClmArchive, ClmArchiveKind } from "./clm-archive";
import type { ClmArchiveSearchResult } from "./clm-archive-search";
import type { ContextProjectionEntry } from "./session-entries";

/** Options shared by archive reads made on behalf of another session (e.g. a child via `context://parent`). */
interface ClmArchiveScope {
	/** Route named in expand/paging hints; defaults to `context://self/archive`. */
	routePrefix?: string;
	/** Item kinds hidden from listing, search, and item reads. */
	excludeKinds?: readonly ClmArchiveKind[];
}

export type ClmReadTarget =
	/** `continuation`: a later page must come from the snapshot earlier pages did. */
	| { kind: "document"; continuation?: boolean }
	| { kind: "status" }
	| { kind: "history" }
	| { kind: "revision"; revision: string }
	| { kind: "diff"; revision: string }
	| ({ kind: "archive"; offset?: number; limit?: number } & ClmArchiveScope)
	| ({ kind: "archive-item"; id: string } & ClmArchiveScope)
	| ({ kind: "archive-search"; query: string; regex: boolean; limit?: number; rerank: boolean } & ClmArchiveScope);

export interface ClmStageResult {
	status: "staged" | "unchanged";
	revision: string;
	transactionId: string;
}

/** One read: the model-facing text and the same facts as transcript data. */
export interface ClmReadResult {
	text: string;
	details: ClmReadDetails;
}

/** Owner-bound capability; staging never mutates the running model context. */
export interface ClmContextAccess {
	readonly ownerSessionId: string;
	isEnabled(): boolean;
	read(target: ClmReadTarget, signal?: AbortSignal): Promise<ClmReadResult>;
	stage(content: string, transactionId: string, signal?: AbortSignal): Promise<ClmStageResult>;
	/** Verbatim archive of everything that entered this session's context since its last reset. */
	archive(): ClmArchive;
	/** The estimator `archive()` item sizes come from; handoff budgets must count with it too. */
	tokenizer(): Tokenizer;
	/** Messages of block `blockId` in the newest document snapshot this session read. */
	snapshotBlockMessages(blockId: string): { snapshotId: string; messages: readonly AgentMessage[] } | undefined;
}

/** Read-only views behind the `/context` inspector; nothing here registers a snapshot or edits context. */
export interface ClmContextInspector {
	inspect(): ContextInspectorSnapshot;
	/** Blocks a revision removed and added relative to its predecessor. */
	revisionDiff(revision: string): ContextInspectorDiff;
	/** The ranking `context://self/archive?q=` renders, as data. */
	searchArchive(query: string, regex: boolean, signal?: AbortSignal): Promise<ClmArchiveSearchResult>;
}

/**
 * Read-only grant a spawning parent hands its subagent: `context://parent/archive*` reads the
 * parent's archive through `access`; nothing else of the parent is reachable and nothing is writable.
 */
export interface ClmParentArchiveGrant {
	readonly access: ClmContextAccess;
	/** Identity captured at spawn; a switched parent must not retarget this grant. */
	readonly ownerSessionId: string;
	/** Parent item kinds hidden from this child (reviewer policy). */
	readonly excludeKinds: readonly ClmArchiveKind[];
}

/**
 * Structured outcome of one CLM write transaction, for the transcript. The model keeps reading the
 * text receipts it always did; `message` carries that text when one was sent.
 */
export type ClmReceipt =
	| {
			kind: "staged";
			transactionId: string;
			revision: string;
			snapshotId: string;
			/** Messages of the read snapshot the draft drops (deleted or collapsed into a note). */
			removed: number;
			/** Model notes the draft adds. */
			notes: number;
			message: string;
	  }
	| {
			kind: "committed";
			revision: string;
			cause: ContextProjectionEntry["cause"];
			tokensBefore: number;
			tokensAfter: number;
			message: string;
	  }
	| {
			kind: "rejected";
			transactionId: string;
			reason: string;
			/** Absent when the write failed before staging; that failure reached the model as the tool error. */
			message?: string;
	  };

/** Transcript-only CLM events; RPC/print consumers keep the plain `notice` stream. */
export type ClmActivity = { type: "receipt"; receipt: ClmReceipt } | { type: "notice"; notice: ClmPressureNotice };

/**
 * Details of the journaled `clm-feedback` message: the transcript activity (pressure chips and
 * rejected receipts) its notices rendered as live, in order, so a rebuilt transcript shows them too.
 */
export interface ClmFeedbackDetails {
	activity: ClmActivity[];
}
