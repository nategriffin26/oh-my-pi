import { type AgentMessage, type AgentTurnEndContext, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { convertMessageToLlm } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { Judge, Model } from "@oh-my-pi/pi-ai";
import type {
	ContextInspectorBlock,
	ContextInspectorDiff,
	ContextInspectorSnapshot,
} from "@oh-my-pi/pi-tui/overlays/context-inspector";
import { isUserTurnInitiator } from "@oh-my-pi/pi-tui/chat/messages";
import { isRecord } from "@oh-my-pi/pi-utils";
import { retireDiagnosticMessages } from "../lsp/diagnostic-state";
import type { ClmBlockRow } from "@oh-my-pi/pi-tui/tools/clm-render";
import {
	buildClmArchive,
	type ClmArchive,
	clmArchiveRow,
	clmPreview,
	excludeArchiveKinds,
	renderArchiveManifest,
	renderOutOfContextIndex,
} from "./clm-archive";
import { type ClmArchiveSearchResult, rankClmArchive, searchClmArchive } from "./clm-archive-search";
import type { ClmBudgetEstimate, ClmCapacity } from "./clm-budget";
import { applyClmDocument, type ClmDocumentBlock, createClmDocument, type ClmDocumentSnapshot } from "./clm-document";
import {
	assertClmMessages,
	CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE,
	createClmRewriteMessage,
	getContextProjectionMessages,
	isClmProtectedControl,
} from "./clm-state";
import type {
	ClmContextAccess,
	ClmContextInspector,
	ClmReadResult,
	ClmReadTarget,
	ClmReceipt,
	ClmStageResult,
} from "./clm-types";
import type { ContextProjectionEntry } from "./session-entries";
import { buildSessionContext } from "./session-context";
import { diffClmContexts } from "./clm-history";
import { assertLosslessPersistence } from "./session-persistence";
import { type SessionManager, SessionPersistenceIndeterminateError } from "./session-manager";

export interface ClmContextHost {
	manager: SessionManager;
	enabled(): boolean;
	epoch(): string;
	isDisposed(): boolean;
	isStreaming(): boolean;
	model(): Model | undefined;
	messages(): AgentMessage[];
	protectedMessages?(): readonly AgentMessage[];
	ownerGeneration?(): number;
	estimate(messages: AgentMessage[]): number;
	assertFits(messages: AgentMessage[]): void;
	budget?(): ClmBudgetEstimate &
		ClmCapacity & {
			lastObservedUsage: {
				promptTokens: number;
				provider: string;
				model: string;
				timestamp: number;
				historical: boolean;
			} | null;
		};
	persistTurn(context: AgentTurnEndContext | undefined): Promise<boolean>;
	publish(messages: AgentMessage[], activeMessages?: AgentMessage[], pendingRequestMessages?: AgentMessage[]): void;
	/**
	 * Model-facing feedback. `receipt` is the transcript receipt this text reports, journaled with the
	 * feedback so a rebuilt transcript shows it like the live one.
	 */
	notice(level: "info" | "warning", message: string, generation?: number, receipt?: ClmReceipt): void;
	/** Structured transaction outcome for the transcript; the model's view stays `notice`. */
	receipt?(receipt: ClmReceipt): void;
	/** The CLM budget's tokenizer, so archive item sizes match `context://self/status`. */
	tokenizer?(): Tokenizer;
	/**
	 * Native judge (TypeSafe Jev) for archive rerank; `undefined` keeps archive search lexical, and a
	 * string keeps it lexical with that reason (e.g. the user chose lexical recall).
	 */
	recallJudge?(): Judge | string | undefined;
}

interface OwnedSnapshot {
	document: ClmDocumentSnapshot;
	owner: string;
	generation: number | undefined;
	epoch: string;
	model: Model | undefined;
	leaf: string | null;
	fingerprints: string[];
}

interface Draft {
	source: OwnedSnapshot;
	messages: AgentMessage[];
	transactionId: string;
	content: string;
}

function fingerprint(message: AgentMessage): string {
	if (message.role === "assistant") {
		// Journal hooks decorate the display copy after tools begin; these fields do not change replay content.
		const { contextSnapshot: _snapshot, completedAt: _completed, ...semantic } = message;
		return Bun.hash(JSON.stringify(semantic)).toString(16);
	}
	return Bun.hash(JSON.stringify(message)).toString(16);
}

/** Atomic block LCS: blocks `before` lost (`-`) and `after` gained (`+`); unchanged islands are never edits. */
function diffBlockOps(
	before: ClmDocumentSnapshot,
	after: ClmDocumentSnapshot,
): { op: "-" | "+"; block: ClmDocumentBlock }[] {
	const a = before.blocks;
	const b = after.blocks;
	const width = b.length + 1;
	const lcs = new Uint32Array((a.length + 1) * width);
	const equal = (i: number, j: number) => a[i].text === b[j].text && a[i].role === b[j].role;
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i * width + j] = equal(i, j)
				? 1 + lcs[(i + 1) * width + j + 1]
				: Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
		}
	}
	const ops: { op: "-" | "+"; block: ClmDocumentBlock }[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && equal(i, j)) {
			i++;
			j++;
		} else if (i < a.length && (j === b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
			ops.push({ op: "-", block: a[i++] });
		} else {
			ops.push({ op: "+", block: b[j++] });
		}
	}
	return ops;
}

function diffBlocks(before: ClmDocumentSnapshot, after: ClmDocumentSnapshot): string {
	const lines = [`--- ${before.revision}`, `+++ ${after.revision}`];
	for (const { op, block } of diffBlockOps(before, after)) {
		lines.push(...block.text.split("\n").map(line => `${op}${line}`));
	}
	return lines.join("\n");
}

function inspectorBlock(block: ClmDocumentBlock, tokenizer: Tokenizer): ContextInspectorBlock {
	return {
		id: block.id,
		role: block.role,
		tokens: tokenizer.countTokens(block.text),
		protectedKind: block.protectedKind,
		opaque: block.opaque,
		text: block.text,
	};
}

/** A session-owned transaction. The live arrays change only after the journal is durable. */
export class ClmContext implements ClmContextAccess, ClmContextInspector {
	readonly #host: ClmContextHost;
	readonly #snapshots = new Map<string, OwnedSnapshot>();
	#draft: Draft | undefined;
	#committing = false;
	#boundaryCommit: Promise<void> | undefined;
	#publicationError: Error | undefined;
	#lastReceipt: string | undefined;
	#archive:
		| {
				leaf: string | null;
				journalRevision: number;
				cwd: string;
				tokenizer: Tokenizer;
				fingerprints: string[];
				archive: ClmArchive;
		  }
		| undefined;
	#fallbackTokenizer: Tokenizer | undefined;
	/** Block rows of document snapshots this session read; keyed weakly so evicted snapshots release them. */
	readonly #blockRows = new WeakMap<ClmDocumentSnapshot, ClmBlockRow[]>();

	constructor(host: ClmContextHost) {
		this.#host = host;
	}

	get ownerSessionId(): string {
		return this.#host.manager.getSessionId();
	}

	isEnabled(): boolean {
		return this.#host.enabled() && !this.#host.isDisposed();
	}

	get #revision(): string {
		const branch = this.#host.manager.getBranch();
		const boundary = branch.findLast(
			entry => entry.type === "context_projection" || entry.type === "compaction" || entry.type === "reset_boundary",
		);
		return boundary?.id ?? `root:${this.ownerSessionId}`;
	}

	assertHealthy(): void {
		if (this.#publicationError) throw this.#publicationError;
	}

	#assertAvailable(write = false): void {
		if (write) this.assertHealthy();
		if (this.#host.isDisposed()) throw new Error("CLM session is disposed");
		if (write && !this.isEnabled()) throw new Error("Enable compaction.experimentalClm before editing context");
	}

	#capture(messages = this.#host.messages()): OwnedSnapshot {
		const source = messages.slice();
		const protectedMessages = this.#host.protectedMessages?.() ?? [];
		return {
			document: createClmDocument(source, {
				revision: this.#revision,
				snapshotId: Bun.randomUUIDv7(),
				protectedIndexes: new Set(
					source.flatMap((message, index) => (protectedMessages.includes(message) ? [index] : [])),
				),
			}),
			owner: this.ownerSessionId,
			generation: this.#host.ownerGeneration?.(),
			epoch: this.#host.epoch(),
			model: this.#host.model(),
			leaf: this.#host.manager.getLeafId(),
			fingerprints: source.map(fingerprint),
		};
	}

	#assertCurrent(source: OwnedSnapshot, messages: AgentMessage[]): void {
		this.#assertAvailable();
		if (
			!this.#host.manager.continuesSession(source.owner) ||
			source.generation !== this.#host.ownerGeneration?.() ||
			source.epoch !== this.#host.epoch() ||
			source.model !== this.#host.model() ||
			source.document.revision !== this.#revision ||
			(source.leaf !== null && !this.#host.manager.getBranch().some(entry => entry.id === source.leaf))
		) {
			throw new Error("Stale CLM snapshot: session, branch, model, or revision changed; read context://self again");
		}
		if (
			messages.length < source.fingerprints.length ||
			source.fingerprints.some((value, index) => value !== fingerprint(messages[index]))
		) {
			throw new Error("Stale CLM snapshot: source context was rewritten; read context://self again");
		}
	}

	#visibleRevisions(): ContextProjectionEntry[] {
		const branch = this.#host.manager.getBranch();
		const reset = branch.findLastIndex(entry => entry.type === "reset_boundary");
		return branch
			.slice(reset + 1)
			.filter((entry): entry is ContextProjectionEntry => entry.type === "context_projection");
	}

	#resolveRevision(revision: string): { id: string; messages: AgentMessage[]; entry?: ContextProjectionEntry } {
		const revisions = this.#visibleRevisions();
		if (revision === "previous" && revisions.length === 0)
			throw new Error("No previous CLM revision exists on this branch");
		if (revision === "previous" && revisions.length === 1) return this.#predecessor(revisions[0]);
		const entry = revision === "previous" ? revisions.at(-2) : revisions.find(item => item.id === revision);
		if (!entry) throw new Error(`CLM revision is not visible on this branch: ${revision}`);
		return { id: entry.id, messages: getContextProjectionMessages(entry), entry };
	}

	#predecessor(entry: ContextProjectionEntry): { id: string; messages: AgentMessage[] } {
		if (entry.previousRevisionId) return this.#resolveRevision(entry.previousRevisionId);
		const branch = entry.parentId === null ? [] : this.#host.manager.getBranch(entry.parentId);
		const boundary = branch.findLast(item => item.type === "compaction" || item.type === "reset_boundary");
		return {
			id: boundary?.id ?? `root:${this.ownerSessionId}`,
			messages: buildSessionContext(branch, entry.parentId).messages,
		};
	}

	/** The estimator archive item sizes use: the CLM budget's, else one stable fallback. */
	tokenizer(): Tokenizer {
		return this.#host.tokenizer?.() ?? (this.#fallbackTokenizer ??= new Tokenizer());
	}

	/** Live fingerprints cover same-length replacements and in-place streaming content updates. */
	archive(): ClmArchive {
		const leaf = this.#host.manager.getLeafId();
		const journalRevision = this.#host.manager.getArchiveRevision();
		const cwd = this.#host.manager.getCwd();
		const live = this.#host.messages();
		const tokenizer = this.tokenizer();
		const cached = this.#archive;
		if (
			cached &&
			cached.leaf === leaf &&
			cached.journalRevision === journalRevision &&
			cached.cwd === cwd &&
			cached.tokenizer === tokenizer &&
			cached.fingerprints.length === live.length &&
			cached.fingerprints.every((value, index) => value === fingerprint(live[index]))
		)
			return cached.archive;
		const archive = buildClmArchive(this.#host.manager, { live, tokenizer });
		this.#archive = { leaf, journalRevision, cwd, tokenizer, fingerprints: live.map(fingerprint), archive };
		return archive;
	}

	snapshotBlockMessages(blockId: string): { snapshotId: string; messages: readonly AgentMessage[] } | undefined {
		const source = [...this.#snapshots.values()].at(-1);
		if (source) this.#assertCurrent(source, this.#host.messages());
		const document = source?.document;
		const block = document?.blocks.find(item => item.id === blockId);
		if (!document || !block) return undefined;
		return { snapshotId: document.snapshotId, messages: document.messages.slice(block.start, block.end) };
	}

	/** The effective context, its revisions and its archive for the `/context` inspector; registers no snapshot. */
	inspect(): ContextInspectorSnapshot {
		this.#assertAvailable();
		const tokenizer = this.tokenizer();
		const budget = this.#host.budget?.();
		return {
			revision: this.#revision,
			estimatedRequestTokens: budget?.estimatedRequestTokens ?? this.#host.estimate(this.#host.messages()),
			softLimitTokens: budget?.softLimitTokens,
			blocks: this.#capture().document.blocks.map(block => inspectorBlock(block, tokenizer)),
			revisions: this.#visibleRevisions().map(entry => ({
				id: entry.id,
				previousRevision: entry.previousRevisionId,
				cause: entry.cause,
				timestamp: entry.timestamp,
				tokensBefore: entry.tokensBefore,
				tokensAfter: entry.tokensAfter,
			})),
			archive: this.archive().items,
		};
	}

	/** Blocks `revision` removed and added relative to its predecessor, as data. */
	revisionDiff(revision: string): ContextInspectorDiff {
		this.#assertAvailable();
		const resolved = this.#resolveRevision(revision);
		if (!resolved.entry) throw new Error(`CLM revision has no recorded predecessor: ${revision}`);
		const predecessor = this.#predecessor(resolved.entry);
		const before = createClmDocument(predecessor.messages, {
			revision: predecessor.id,
			snapshotId: `archive:${predecessor.id}`,
		});
		const after = createClmDocument(resolved.messages, {
			revision: resolved.id,
			snapshotId: `archive:${resolved.id}`,
		});
		const tokenizer = this.tokenizer();
		return {
			before: predecessor.id,
			after: resolved.id,
			changes: diffBlockOps(before, after).map(({ op, block }) => ({ op, block: inspectorBlock(block, tokenizer) })),
		};
	}

	/** Rank an archive search the way `context://self/archive?q=` does (rerank per the recall setting), as data. */
	searchArchive(query: string, regex: boolean, signal?: AbortSignal): Promise<ClmArchiveSearchResult> {
		this.#assertAvailable();
		const judge = regex ? undefined : this.#host.recallJudge?.();
		return rankClmArchive(this.archive(), {
			query,
			regex,
			judge: typeof judge === "string" ? undefined : judge,
			judgeUnavailable: typeof judge === "string" ? judge : undefined,
			signal,
		});
	}

	/** Model-facing envelope text plus its block table; row sizes are cached per snapshot so later pages stay cheap. */
	#documentRead(document: ClmDocumentSnapshot, kind: "document" | "revision"): ClmReadResult {
		let blocks = this.#blockRows.get(document);
		if (!blocks) {
			const tokenizer = this.tokenizer();
			blocks = document.blocks.map(block => ({
				id: block.id,
				role: block.role,
				tokens: tokenizer.countTokens(block.text),
				...(block.protected ? { protected: true as const } : {}),
				...(block.opaque ? { opaque: true as const } : {}),
				preview: clmPreview(block.text),
			}));
			this.#blockRows.set(document, blocks);
		}
		const softLimitTokens = this.#host.budget?.().softLimitTokens;
		return {
			text: document.text,
			details: {
				kind,
				revision: document.revision,
				snapshotId: document.snapshotId,
				tokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
				...(softLimitTokens ? { softLimitTokens } : {}),
				blocks,
			},
		};
	}

	async read(target: ClmReadTarget, signal?: AbortSignal): Promise<ClmReadResult> {
		signal?.throwIfAborted();
		this.#assertAvailable();
		if (target.kind === "status") {
			const budget = this.#host.budget?.();
			const estimate = budget?.estimatedRequestTokens ?? this.#host.estimate(this.#host.messages());
			const staged = this.#draft?.transactionId ?? null;
			const contextWindow = this.#host.model()?.contextWindow ?? null;
			const lastReceipt = this.#lastReceipt ?? null;
			return {
				text: JSON.stringify(
					{
						experimental: true,
						enabled: this.isEnabled(),
						sessionId: this.ownerSessionId,
						revision: this.#revision,
						staged,
						estimatedRequestTokens: estimate,
						...budget,
						contextWindow,
						lastReceipt,
					},
					null,
					2,
				),
				details: {
					kind: "status",
					revision: this.#revision,
					staged,
					estimatedRequestTokens: estimate,
					...(budget
						? {
								localRequestTokens: budget.localRequestTokens,
								localExact: budget.localExact,
								safetyMarginTokens: budget.safetyMarginTokens,
								generationReserveTokens: budget.generationReserveTokens,
								softLimitTokens: budget.softLimitTokens,
								capacityTokens: budget.capacityTokens,
								remainingTokens: budget.remainingTokens,
							}
						: {}),
					contextWindow,
					lastReceipt,
				},
			};
		}
		if (target.kind === "history") {
			const revisions = this.#visibleRevisions().map(entry => ({
				revision: entry.id,
				previousRevision: entry.previousRevisionId,
				cause: entry.cause,
				timestamp: entry.timestamp,
				tokensBefore: entry.tokensBefore,
				tokensAfter: entry.tokensAfter,
			}));
			return { text: JSON.stringify(revisions, null, 2), details: { kind: "history", revisions } };
		}
		if (target.kind === "archive" || target.kind === "archive-item" || target.kind === "archive-search") {
			const archive = excludeArchiveKinds(this.archive(), target.excludeKinds ?? []);
			if (target.kind === "archive") {
				return renderArchiveManifest(archive, {
					offset: target.offset,
					limit: target.limit,
					routePrefix: target.routePrefix,
				});
			}
			if (target.kind === "archive-item") {
				const item = archive.get(target.id);
				if (item)
					return {
						text: item.text,
						details: { kind: "archive-item", item: clmArchiveRow(item), lines: item.text.split("\n").length },
					};
				if (this.archive().get(target.id))
					throw new Error(`Archive item ${target.id} is excluded by reviewer policy`);
				throw new Error(
					`Unknown archive id ${target.id}; list ids via ${target.routePrefix ?? "context://self/archive"} or search with ?q=`,
				);
			}
			const judge = target.rerank && !target.regex ? this.#host.recallJudge?.() : undefined;
			return searchClmArchive(archive, {
				query: target.query,
				regex: target.regex,
				limit: target.limit,
				rerank: target.rerank,
				judge: typeof judge === "string" ? undefined : judge,
				judgeUnavailable: typeof judge === "string" ? judge : undefined,
				routePrefix: target.routePrefix,
				signal,
			});
		}
		if (target.kind === "revision" || target.kind === "diff") {
			const compareCurrent = target.revision.startsWith("current:");
			const revision = this.#resolveRevision(compareCurrent ? target.revision.slice(8) : target.revision);
			const archived = createClmDocument(revision.messages, {
				revision: revision.id,
				snapshotId: `archive:${revision.id}`,
			});
			if (target.kind === "revision") return this.#documentRead(archived, "revision");
			const predecessor = revision.entry && !compareCurrent ? this.#predecessor(revision.entry) : undefined;
			const before = predecessor
				? createClmDocument(predecessor.messages, {
						revision: predecessor.id,
						snapshotId: `archive:${predecessor.id}`,
					})
				: archived;
			const after = predecessor ? archived : this.#capture().document;
			return {
				text: diffBlocks(before, after),
				details: { kind: "diff", before: before.revision, after: after.revision },
			};
		}

		const newest = [...this.#snapshots.values()].at(-1);
		const live = this.#host.messages();
		const owned =
			newest !== undefined &&
			newest.document.revision === this.#revision &&
			this.#host.manager.continuesSession(newest.owner) &&
			newest.epoch === this.#host.epoch() &&
			newest.generation === this.#host.ownerGeneration?.() &&
			newest.model === this.#host.model() &&
			live.length >= newest.fingerprints.length &&
			newest.fingerprints.every((value, index) => value === fingerprint(live[index]));
		// A later page keeps its snapshot while the context only appended; staging preserves that suffix.
		if (owned && (target.continuation || live.length === newest.fingerprints.length))
			return this.#documentRead(newest.document, "document");
		const snapshot = this.#capture(live);
		this.#snapshots.set(snapshot.document.snapshotId, snapshot);
		if (this.#snapshots.size > 4) this.#snapshots.delete(this.#snapshots.keys().next().value!);
		if (target.continuation) {
			throw new Error(
				`CLM context changed since the earlier page (rewritten, committed, or never read); current snapshot is ${snapshot.document.snapshotId}. Read context://self:raw again from line 1 before writing.`,
			);
		}
		return this.#documentRead(snapshot.document, "document");
	}

	async stage(content: string, transactionId: string, signal?: AbortSignal): Promise<ClmStageResult> {
		try {
			return await this.#stage(content, transactionId, signal);
		} catch (error) {
			if (!signal?.aborted) {
				this.#host.receipt?.({
					kind: "rejected",
					transactionId,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
			throw error;
		}
	}

	async #stage(content: string, transactionId: string, signal?: AbortSignal): Promise<ClmStageResult> {
		signal?.throwIfAborted();
		this.#assertAvailable(true);
		if (this.#committing || this.#boundaryCommit)
			throw new Error("A CLM revision is committing; retry after its receipt");
		if (this.#draft) {
			if (this.#draft.content === content) {
				return {
					status: "staged",
					revision: this.#draft.source.document.revision,
					transactionId: this.#draft.transactionId,
				};
			}
			throw new Error("A CLM writer already staged this boundary; wait for its receipt before another write");
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(content);
		} catch {
			throw new Error("CLM requires a complete JSON document");
		}
		const snapshotId =
			isRecord(envelope) && typeof envelope.snapshotId === "string" ? envelope.snapshotId : undefined;
		const source = snapshotId ? this.#snapshots.get(snapshotId) : undefined;
		if (!source) throw new Error("Unknown CLM snapshot; read context://self in this session before writing");
		const current = this.#host.messages();
		this.#assertCurrent(source, current);
		assertClmMessages(current);
		const compiled = applyClmDocument(content, source.document);
		if (!compiled.changed) return { status: "unchanged", revision: this.#revision, transactionId };
		// Include the still-owned suffix (including sibling tool results) in capacity checks.
		const candidate = [...compiled.messages, ...current.slice(source.document.messages.length)];
		for (const block of source.document.blocks) {
			const native = source.document.messages
				.slice(block.start, block.end)
				.filter(message => candidate.includes(message));
			try {
				assertLosslessPersistence(native);
			} catch (error) {
				throw new Error(
					`CLM block ${block.id} cannot persist losslessly: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		assertLosslessPersistence(candidate);
		this.#host.assertFits(candidate);
		this.#draft = { source, messages: compiled.messages, transactionId, content };
		const message = `CLM staged ${transactionId}; active revision is still ${this.#revision}`;
		const draft = diffClmContexts(source.document.messages, compiled.messages);
		// Receipt first: the transcript claims the notice text it renders as a card.
		this.#host.receipt?.({
			kind: "staged",
			transactionId,
			revision: this.#revision,
			snapshotId: source.document.snapshotId,
			removed: draft.removed.length,
			notes: draft.notes.length,
			message,
		});
		this.#host.notice("info", message, source.generation);
		return { status: "staged", revision: this.#revision, transactionId };
	}

	discard(reason: string): void {
		if (this.#draft) {
			this.#lastReceipt = `CLM rejected ${this.#draft.transactionId}: ${reason}`;
			const receipt: ClmReceipt = {
				kind: "rejected",
				transactionId: this.#draft.transactionId,
				reason,
				message: this.#lastReceipt,
			};
			this.#host.receipt?.(receipt);
			this.#host.notice("warning", this.#lastReceipt, this.#draft.source.generation, receipt);
		}
		this.#draft = undefined;
		this.#snapshots.clear();
	}

	async commitBoundary(
		activeMessages: AgentMessage[],
		signal?: AbortSignal,
		context?: AgentTurnEndContext,
	): Promise<void> {
		this.assertHealthy();
		if (this.#boundaryCommit) return this.#boundaryCommit;
		const draft = this.#draft;
		if (!draft) return this.retireDiagnostics(activeMessages, signal, context);
		this.#boundaryCommit = this.#finishBoundary(draft, activeMessages, signal, context).finally(() => {
			this.#boundaryCommit = undefined;
		});
		return this.#boundaryCommit;
	}

	/** Host observations retire only through the same durable owner as model edits. */
	async retireDiagnostics(
		activeMessages: AgentMessage[],
		signal?: AbortSignal,
		context?: AgentTurnEndContext,
		/** Preconversion requests can contain input not yet emitted into owned state. */
		pendingRequest?: AgentMessage[],
	): Promise<void> {
		this.assertHealthy();
		if (this.#boundaryCommit) return this.#boundaryCommit;
		if (signal?.aborted || this.#draft) return;
		if (this.#committing) throw new Error("A CLM revision is already committing");
		const messages = retireDiagnosticMessages(activeMessages, this.#host.manager.getEntries());
		if (messages === activeMessages) return;
		const source = this.#capture(activeMessages);
		if (
			pendingRequest &&
			(pendingRequest.length < source.fingerprints.length ||
				source.fingerprints.some((value, index) => value !== fingerprint(pendingRequest[index])))
		) {
			throw new Error("Diagnostic retirement requires an owned request prefix");
		}
		this.#boundaryCommit = (async () => {
			if (!(await this.#host.persistTurn(context)))
				throw new Error("Diagnostic retirement requires persisted turn outcomes");
			signal?.throwIfAborted();
			await this.#commit(messages, "diagnostics", source, activeMessages, signal, pendingRequest);
		})().finally(() => {
			this.#boundaryCommit = undefined;
		});
		return this.#boundaryCommit;
	}

	async #finishBoundary(
		draft: Draft,
		activeMessages: AgentMessage[],
		signal?: AbortSignal,
		context?: AgentTurnEndContext,
	): Promise<void> {
		if (
			signal?.aborted ||
			(context?.message.role === "assistant" &&
				(context.message.stopReason === "aborted" || context.message.stopReason === "error"))
		) {
			this.discard("turn aborted or failed");
			return;
		}
		try {
			if (!(await this.#host.persistTurn(context))) throw new Error("Turn outcomes were not persisted in order");
			signal?.throwIfAborted();
			if (this.#draft !== draft) return;
			this.#assertAvailable(true);
			this.#assertCurrent(draft.source, activeMessages);
			const messages = [...draft.messages, ...activeMessages.slice(draft.source.document.messages.length)];
			await this.#commit(messages, "edit", this.#capture(activeMessages), activeMessages, signal);
		} catch (error) {
			if (this.#publicationError || error instanceof SessionPersistenceIndeterminateError) {
				this.#publicationError ??= error instanceof Error ? error : new Error(String(error));
				throw this.#publicationError;
			}
			this.discard(error instanceof Error ? error.message : String(error));
		}
	}

	async commitExternal(
		messages: AgentMessage[],
		cause: "compact" | "rebase",
		sourceMessages: AgentMessage[],
	): Promise<void> {
		if (this.#draft || this.#boundaryCommit || this.#committing)
			throw new Error("Finish or discard the pending CLM edit before compacting");
		const source = this.#capture(sourceMessages);
		this.#assertCurrent(source, this.#host.messages());
		await this.#commit(messages, cause, source);
	}

	async spillToolOutputs(
		activeMessages: AgentMessage[],
		replacements: ReadonlyMap<AgentMessage, AgentMessage>,
		signal?: AbortSignal,
		pendingRequest?: AgentMessage[],
	): Promise<void> {
		this.#assertAvailable(true);
		if (this.#draft || this.#boundaryCommit || this.#committing)
			throw new Error("Finish or discard the pending CLM edit before spilling outputs");
		signal?.throwIfAborted();
		const source = this.#capture(activeMessages);
		if (
			pendingRequest &&
			(pendingRequest.length < source.fingerprints.length ||
				source.fingerprints.some((value, index) => value !== fingerprint(pendingRequest[index])))
		)
			throw new Error("Output spill requires an owned request prefix");
		const messages = activeMessages.map(message => replacements.get(message) ?? message);
		this.#boundaryCommit = (async () => {
			if (!(await this.#host.persistTurn(undefined)))
				throw new Error("Output spill requires persisted turn outcomes");
			signal?.throwIfAborted();
			await this.#commit(messages, "spill", source, activeMessages, signal, pendingRequest);
		})().finally(() => {
			this.#boundaryCommit = undefined;
		});
		return this.#boundaryCommit;
	}

	async restore(revision: string): Promise<string> {
		this.#assertAvailable(true);
		if (this.#host.isStreaming()) throw new Error("Stop the active turn before restoring a CLM revision");
		if (this.#draft || this.#boundaryCommit || this.#committing)
			throw new Error("Finish or discard the pending CLM edit before restoring");
		const source = this.#capture();
		const messages = this.#resolveRevision(revision).messages;
		const current = source.document.messages;
		const pinned = this.#host.protectedMessages?.() ?? [];
		const initiator = current.findLastIndex(
			message =>
				pinned.includes(message) ||
				(message.role === "user" && message.attribution !== "agent") ||
				(message.role === "custom" && isUserTurnInitiator(message)),
		);
		let restored = messages.slice();
		const missingDevelopers = current.filter(
			(message, index) =>
				isClmProtectedControl(message) &&
				(initiator < 0 || index < initiator) &&
				!restored.some(item => fingerprint(item) === fingerprint(message)),
		);
		if (initiator >= 0) {
			const key = fingerprint(current[initiator]);
			const match = restored.findLastIndex(message => fingerprint(message) === key);
			restored = [
				...(match >= 0 ? restored.slice(0, match) : restored),
				...missingDevelopers,
				...current.slice(initiator),
			];
		} else {
			restored.push(...missingDevelopers);
		}
		await this.#commit(restored, "restore", source);
		return this.#lastReceipt!;
	}

	/** Derive membership from the archive against the candidate, never from rendered block text. */
	#withOutOfContextIndex(
		messages: AgentMessage[],
		timestamp: number,
	): { messages: AgentMessage[]; archiveItems: number } {
		const retained = messages.filter(
			message => message.role !== "custom" || message.customType !== CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE,
		);
		const tokenizer = this.tokenizer();
		const archiveItems = buildClmArchive(this.#host.manager, { live: retained, tokenizer }).items;
		const content = renderOutOfContextIndex(archiveItems, {
			cwd: this.#host.manager.getCwd(),
			// Bound the escaped provider text, including its trust wrapper and overflow hint.
			fits: candidate => {
				const lowered = convertMessageToLlm({ role: "clmNote", content: candidate, timestamp });
				if (!lowered || lowered.role !== "user") throw new Error("CLM index must lower as historical user data");
				const text =
					typeof lowered.content === "string"
						? lowered.content
						: lowered.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
				return tokenizer.countTokens(text) <= 1000;
			},
		});
		if (content === undefined) return { messages: retained, archiveItems: archiveItems.length };
		retained.push({
			role: "custom",
			customType: CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE,
			content,
			display: false,
			timestamp,
		});
		return { messages: retained, archiveItems: archiveItems.length };
	}

	async #commit(
		messages: AgentMessage[],
		cause: ContextProjectionEntry["cause"],
		source: OwnedSnapshot,
		activeMessages?: AgentMessage[],
		signal?: AbortSignal,
		pendingRequest?: AgentMessage[],
	): Promise<void> {
		this.assertHealthy();
		if (this.#committing) throw new Error("A CLM revision is already committing");
		this.#committing = true;
		let durable = false;
		try {
			const before = source.document.messages;
			const archiveItemsBefore = this.archive().items.length;
			messages = messages.filter(
				message => message.role !== "custom" || message.customType !== CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE,
			);
			messages = retireDiagnosticMessages(messages, this.#host.manager.getEntries());
			let divergence = 0;
			while (
				divergence < before.length &&
				divergence < messages.length &&
				before[divergence] === messages[divergence]
			)
				divergence++;
			let rewriteAt = Date.now();
			let markerIndex = messages
				.slice(0, divergence)
				.filter(
					message =>
						!(message.role === "clmNote" && message.content === "" && message.historyRewriteAt !== undefined),
				).length;
			let retainedCount = 0;
			const retained: AgentMessage[] = [];
			for (let index = 0; index < messages.length; index++) {
				const message = messages[index];
				if (message.role === "clmNote" && message.content === "" && message.historyRewriteAt !== undefined) {
					markerIndex = Math.min(markerIndex, retainedCount);
					rewriteAt = Math.max(rewriteAt, message.historyRewriteAt);
				} else {
					retained.push(message);
					retainedCount++;
				}
			}
			// Spills and diagnostic retirement replace results in place; the marker rides before the
			// whole exchange, never between a native call and its results.
			while (markerIndex > 0 && retained[markerIndex]?.role === "toolResult") markerIndex--;
			const candidate = [
				...retained.slice(0, markerIndex),
				createClmRewriteMessage(rewriteAt),
				...retained.slice(markerIndex),
			];
			assertClmMessages(candidate);
			if (cause !== "diagnostics" && cause !== "spill") this.#host.assertFits(candidate);
			const budget = this.#host.budget?.();
			const tokensBefore = budget?.usageAnchor.valid ? budget.estimatedRequestTokens : this.#host.estimate(before);
			let publication = candidate;
			let coveredMessageCount = before.length;
			let coveredFingerprints = source.fingerprints;
			let tokensAfter = this.#host.estimate(candidate);
			let archiveItems = archiveItemsBefore;
			const revision = await this.#host.manager.appendEntriesAtomically(() => {
				signal?.throwIfAborted();
				const live = activeMessages ?? this.#host.messages();
				this.#assertCurrent(source, live);
				const suffix = live.slice(before.length);
				publication = retireDiagnosticMessages(
					suffix.length ? [...candidate, ...suffix] : candidate,
					this.#host.manager.getEntries(),
				);
				const indexed = this.#withOutOfContextIndex(publication, rewriteAt);
				publication = indexed.messages;
				archiveItems = indexed.archiveItems;
				assertClmMessages(publication);
				coveredMessageCount = live.length;
				coveredFingerprints = live.map(fingerprint);
				if (cause !== "diagnostics" && cause !== "spill") this.#host.assertFits(publication);
				tokensAfter = this.#host.estimate(publication);
				return this.#host.manager.appendContextProjection({
					previousRevisionId: this.#host.manager.getLatestContextProjection()?.id,
					coveredThroughEntryId: this.#host.manager.getLeafId(),
					messages: publication,
					rewriteAt,
					tokensBefore,
					tokensAfter,
					cause,
					archiveItems,
					archiveGrowth: archiveItems - archiveItemsBefore,
				});
			});
			durable = true;
			// Cancellation after durable publication cannot roll back the accepted revision. An interrupt
			// or model switch only advances the prompt epoch; the owned prefix is what must still match.
			// A session transition publishes its own branch; never overwrite that new owner. Persistence
			// moving this conversation to a sibling file is not a transition.
			const live = activeMessages ?? this.#host.messages();
			if (
				!this.#host.manager.continuesSession(source.owner) ||
				this.#host.manager.getLatestContextProjection()?.id !== revision ||
				this.#host.isDisposed() ||
				live.length < coveredMessageCount ||
				coveredFingerprints.some((value, index) => value !== fingerprint(live[index]))
			) {
				throw new Error("Context owner or covered prefix changed after durable append");
			}
			const suffix = live.slice(coveredMessageCount);
			let queuedStart = before.length;
			if (pendingRequest) {
				// Inputs emitted while persistence waited are now owned; do not append them twice.
				while (
					queuedStart < live.length &&
					queuedStart < pendingRequest.length &&
					fingerprint(live[queuedStart]) === fingerprint(pendingRequest[queuedStart])
				)
					queuedStart++;
			}
			this.#host.publish(
				suffix.length ? [...publication, ...suffix] : publication,
				pendingRequest ?? activeMessages,
				pendingRequest?.slice(queuedStart),
			);
			this.#draft = undefined;
			this.#snapshots.clear();
			this.#lastReceipt = `CLM committed ${revision} (${cause}): estimated request ${tokensBefore} → ${tokensAfter} local tokens`;
			this.#host.receipt?.({
				kind: "committed",
				revision,
				cause,
				tokensBefore,
				tokensAfter,
				message: this.#lastReceipt,
			});
			if (cause !== "diagnostics") this.#host.notice("info", this.#lastReceipt, source.generation);
		} catch (error) {
			if (durable || error instanceof SessionPersistenceIndeterminateError) {
				this.#publicationError = new Error(
					`CLM publication is indeterminate; restart omp and reopen the session before continuing: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
				throw this.#publicationError;
			}
			throw error;
		} finally {
			this.#committing = false;
		}
	}
}
