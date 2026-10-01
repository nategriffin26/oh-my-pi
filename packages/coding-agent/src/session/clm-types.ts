import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ClmArchive, ClmArchiveKind } from "./clm-archive";

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

/** Owner-bound capability; staging never mutates the running model context. */
export interface ClmContextAccess {
	readonly ownerSessionId: string;
	isEnabled(): boolean;
	read(target: ClmReadTarget, signal?: AbortSignal): Promise<string>;
	stage(content: string, transactionId: string, signal?: AbortSignal): Promise<ClmStageResult>;
	/** Verbatim archive of everything that entered this session's context since its last reset. */
	archive(): ClmArchive;
	/** The estimator `archive()` item sizes come from; handoff budgets must count with it too. */
	tokenizer(): Tokenizer;
	/** Messages of block `blockId` in the newest document snapshot this session read. */
	snapshotBlockMessages(blockId: string): { snapshotId: string; messages: readonly AgentMessage[] } | undefined;
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
