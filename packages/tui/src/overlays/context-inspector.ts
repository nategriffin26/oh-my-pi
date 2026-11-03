/**
 * The `/context` inspector: a fullscreen, read-only view of the session's CLM
 * context document, framed like `/settings`. Three tabs: Blocks (the
 * effective context's blocks), History (context revisions, each with its block
 * diff against its predecessor) and Archive (every item that entered the
 * context, newest first, searchable with the ranking `context://self/archive?q=`
 * uses). A list sits beside the selected entry's detail at wide widths and
 * above it at narrow ones; the detail pane scrolls once focused.
 */
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import {
	bottomBorder,
	divider,
	dividerOpenSplit,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
} from "../chrome/overlay-box";
import { getTabBarTheme } from "../chrome/shared";
import { Input } from "../components/input";
import { type Tab, TabBar } from "../components/tab-bar";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { matchesKey } from "../keys";
import { col, EMPTY_NODE, item, node, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, type NativeHint, overlayCard, selectList } from "../native/overlay";
import { replaceTabs } from "../render/render-utils";
import { type ThemeColor, theme } from "../theme/theme";
import type { Component } from "../tui";
import { styledSpans } from "../native/spans";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";

/** One block of the effective context document. */
export interface ContextInspectorBlock {
	readonly id: string;
	/** Role of the block's opening message (`clmNote` for a model-authored note). */
	readonly role: string;
	readonly tokens: number;
	/** Why the block is pinned, when it is. */
	readonly protectedKind?: string;
	readonly opaque: boolean;
	readonly text: string;
}

/** One context revision (a `context_projection` entry). */
export interface ContextInspectorRevision {
	readonly id: string;
	readonly previousRevision?: string;
	readonly cause: string;
	/** ISO timestamp of the commit. */
	readonly timestamp: string;
	readonly tokensBefore: number;
	readonly tokensAfter: number;
}

/** One archive item, as `context://self/archive` lists it. */
export interface ContextInspectorArchiveItem {
	readonly id: string;
	readonly kind: string;
	readonly toolName?: string;
	readonly label: string;
	readonly text: string;
	readonly tokens: number;
	readonly timestamp: number;
	readonly turn: number;
	readonly occurrences: number;
	readonly inContext: boolean;
	readonly supersededBy?: string;
	readonly truncated?: boolean;
	readonly failed?: boolean;
}

/** What the inspector shows; read once when it opens. */
export interface ContextInspectorSnapshot {
	readonly revision: string;
	readonly estimatedRequestTokens: number;
	/** The configured context-management limit; absent without a known context window. */
	readonly softLimitTokens?: number;
	readonly blocks: readonly ContextInspectorBlock[];
	/** Chronological. */
	readonly revisions: readonly ContextInspectorRevision[];
	/** Chronological. */
	readonly archive: readonly ContextInspectorArchiveItem[];
}

/** Blocks a revision removed (`-`) and added (`+`) relative to its predecessor, in document order. */
export interface ContextInspectorDiff {
	readonly before: string;
	readonly after: string;
	readonly changes: readonly { readonly op: "-" | "+"; readonly block: ContextInspectorBlock }[];
}

export interface ContextInspectorSearchHit {
	readonly item: ContextInspectorArchiveItem;
	readonly lexicalRank?: number;
	/** Judge probability that the item holds what the query looks for. */
	readonly p?: number;
	readonly origin?: string;
}

/** A ranked archive search: best hit first. */
export interface ContextInspectorSearch {
	readonly query: string;
	readonly mode: "lexical" | "jev" | "regex";
	/** Why ranking stayed lexical. */
	readonly fallbackReason?: string;
	readonly matches: number;
	readonly relevant?: number;
	readonly hits: readonly ContextInspectorSearchHit[];
	readonly judge?: {
		readonly requests: number;
		readonly tokens: number;
		readonly costUsd: number;
		readonly ms: number;
	};
}

/** The session behind a {@link ContextInspector}. */
export interface ContextInspectorSource {
	/** Whether this snapshot still belongs to the enabled session being viewed. */
	isCurrent?(): boolean;
	/** The context document, history and archive; read once when the inspector opens. */
	load(): ContextInspectorSnapshot;
	/** A revision's block diff against its predecessor. */
	diff(revision: string): ContextInspectorDiff;
	search(query: string, regex: boolean, signal: AbortSignal): Promise<ContextInspectorSearch>;
	requestRender(): void;
	close(): void;
}

export type ContextInspectorTab = "blocks" | "history" | "archive";

type ListKey = ContextInspectorTab | "search";
type Focus = "list" | "detail" | "search";

interface SearchState {
	readonly query: string;
	readonly regex: boolean;
	readonly controller: AbortController;
	result?: ContextInspectorSearch;
	error?: string;
}

interface ListEntry {
	readonly id: string;
	render(selected: boolean, width: number): string;
	describe(): NativeNode;
}

interface Detail {
	/** Pinned rows: title and facts. */
	readonly head: readonly string[];
	/** Scrolling rows. */
	readonly body: readonly string[];
}

/** Frame width at which the detail pane moves beside the list. */
const SPLIT_MIN_WIDTH = 100;
/** Widest the list pane grows beside the detail. */
const LIST_MAX_WIDTH = 64;
/** Share of the body rows the list keeps when the detail sits below it. */
const STACKED_LIST_SHARE = 0.4;
/** Judge probability at which a hit's relevance reads as strong. */
const STRONG_RELEVANCE = 0.5;

const FLAG_COLOR: Record<string, ThemeColor> = { protected: "warning", note: "customMessageLabel", opaque: "dim" };

function blockRole(block: ContextInspectorBlock): string {
	return block.role === "clmNote" ? "note" : block.role;
}

/** The one flag a list row has room for: protected, then note, then opaque. */
function blockFlag(block: ContextInspectorBlock): string {
	if (block.protectedKind) return "protected";
	if (block.role === "clmNote") return "note";
	return block.opaque ? "opaque" : "";
}

/** Text safe to paint inside the frame: no control sequences, tabs expanded. */
function clean(value: string): string {
	return replaceTabs(sanitizeText(value));
}

function firstLine(value: string): string {
	const trimmed = value.trimStart();
	const end = trimmed.indexOf("\n");
	return clean(end === -1 ? trimmed : trimmed.slice(0, end));
}

function shortRevision(revision: string): string {
	return revision.startsWith("root:") ? "root" : revision;
}

function signedTokens(delta: number): string {
	if (delta === 0) return "±0";
	return `${delta < 0 ? "−" : "+"}${formatNumber(Math.abs(delta))}`;
}

function clockTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : date.toTimeString().slice(0, 8);
}

function archiveWho(entry: ContextInspectorArchiveItem): string {
	const kind = entry.toolName && entry.kind !== "subagent" ? entry.toolName : entry.kind;
	return `${kind} t${entry.turn}`;
}

function cursor(selected: boolean): string {
	return selected ? ` ${theme.fg("accent", theme.nav.cursor)} ` : "   ";
}

function cell(value: string, width: number, color: ThemeColor | undefined, align: "start" | "end" = "start"): string {
	const cut = truncateToWidth(value, width);
	const pad = " ".repeat(Math.max(0, width - visibleWidth(cut)));
	const padded = align === "end" ? pad + cut : cut + pad;
	return color ? theme.fg(color, padded) : padded;
}

/** Wrap plain text to `width`, painting every row `color`. */
function wrapPlain(value: string, width: number, color: ThemeColor): string[] {
	const out: string[] = [];
	for (const line of clean(value).split("\n")) {
		if (line === "") {
			out.push("");
			continue;
		}
		for (const wrapped of wrapTextWithAnsi(line, Math.max(1, width))) out.push(theme.fg(color, wrapped));
	}
	return out;
}

/** Item text with dim `L<n>` gutters, as archive search excerpts number lines. */
function numberedLines(value: string, width: number): string[] {
	const lines = clean(value).split("\n");
	const gutter = `L${lines.length} `.length;
	const room = Math.max(1, width - gutter);
	const out: string[] = [];
	lines.forEach((line, index) => {
		const label = theme.fg("dim", `L${index + 1}`.padEnd(gutter));
		const wrapped = line === "" ? [""] : wrapTextWithAnsi(line, room);
		wrapped.forEach((part, partIndex) => {
			out.push(`${partIndex === 0 ? label : " ".repeat(gutter)}${theme.fg("muted", part)}`);
		});
	});
	return out;
}

/** The first index of a `rows`-tall window over `total` rows that keeps `selected` in view. */
function windowStart(previous: number, selected: number, rows: number, total: number): number {
	let start = Math.min(previous, Math.max(0, total - rows));
	if (selected < start) start = selected;
	else if (selected >= start + rows) start = selected - rows + 1;
	return Math.max(0, start);
}

/**
 * Fullscreen `/context` inspector. Read-only: nothing it does edits the
 * context. Selection is kept per tab (and for search results separately), so
 * switching tabs returns to where each list was.
 */
export class ContextInspector implements Component {
	readonly #source: ContextInspectorSource;
	#closed = false;
	readonly #snapshot: ContextInspectorSnapshot;
	readonly #tabBar: TabBar;
	readonly #searchInput = new Input();
	#tab: ContextInspectorTab = "blocks";
	#focus: Focus = "list";
	readonly #selected: Partial<Record<ListKey, string>> = {};
	readonly #listOffset: Partial<Record<ListKey, number>> = {};
	#detailScroll = 0;
	#detailRows = 1;
	/** List rows the last frame showed: one page for PgUp/PgDn. */
	#listRows = 1;
	#regex = false;
	#search: SearchState | undefined;
	readonly #diffs = new Map<string, ContextInspectorDiff | Error>();
	#detailMemo: { key: string; width: number; detail: Detail } | undefined;
	#native: { signature: string; node: NativeNode } | undefined;

	constructor(source: ContextInspectorSource) {
		this.#source = source;
		this.#snapshot = source.load();
		const tabs: Tab[] = [
			{ id: "blocks", label: `${theme.symbol("tab.context")} Blocks`, short: theme.symbol("tab.context") },
			{ id: "history", label: `${theme.icon.rewind} History`, short: theme.icon.rewind },
			{ id: "archive", label: `${theme.icon.package} Archive`, short: theme.icon.package },
		];
		this.#tabBar = new TabBar("", tabs, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = tab => this.#showTab(tab.id as ContextInspectorTab);
		this.#searchInput.prompt = "";
	}

	/** The active tab. */
	get tab(): ContextInspectorTab {
		return this.#tab;
	}

	/** Id of the selected entry in the visible list. */
	get selectedId(): string | undefined {
		return this.#current().selected?.id;
	}

	/** Where keys go: the list, the detail pane (scrolling) or the archive search field. */
	get focus(): Focus {
		return this.#focus;
	}

	/** The archive search shown, while one is pending or done. */
	get search(): { query: string; pending: boolean; result?: ContextInspectorSearch; error?: string } | undefined {
		const search = this.#search;
		if (!search) return undefined;
		return {
			query: search.query,
			pending: !search.result && !search.error,
			result: search.result,
			error: search.error,
		};
	}

	invalidate(): void {
		this.#tabBar.invalidate();
		this.#detailMemo = undefined;
		this.#native = undefined;
	}

	// ─────────────────────────────── input ───────────────────────────────

	handleInput(data: string): void {
		if (!this.#isCurrent()) return;
		if (this.#focus === "search") this.#handleSearchInput(data);
		else if (this.#focus === "detail") this.#handleDetailInput(data);
		else this.#handleListInput(data);
	}

	#handleListInput(data: string): void {
		const kb = getKeybindings();
		if (matchesSelectCancel(data)) {
			if (this.#tab === "archive" && this.#search) this.#clearSearch();
			else this.#close();
			return;
		}
		if (matchesSelectUp(data)) this.#move(-1);
		else if (matchesSelectDown(data)) this.#move(1);
		else if (matchesSelectPageUp(data)) this.#move(-this.#listRows);
		else if (matchesSelectPageDown(data)) this.#move(this.#listRows);
		else if (matchesKey(data, "home")) this.#move(-Number.MAX_SAFE_INTEGER);
		else if (matchesKey(data, "end")) this.#move(Number.MAX_SAFE_INTEGER);
		else if (kb.matches(data, "tui.select.confirm")) {
			if (this.#current().selected) this.#focus = "detail";
		} else if (matchesKey(data, "/")) this.openSearch();
		else if (matchesKey(data, "d") && this.#tab === "blocks") this.#tabBar.selectTab("history");
		else this.#tabBar.handleInput(data);
	}

	#handleDetailInput(data: string): void {
		const kb = getKeybindings();
		if (matchesSelectCancel(data) || kb.matches(data, "tui.select.confirm") || matchesKey(data, "left")) {
			this.#focus = "list";
		} else if (matchesSelectUp(data)) this.#scrollDetail(-1);
		else if (matchesSelectDown(data)) this.#scrollDetail(1);
		else if (matchesSelectPageUp(data)) this.#scrollDetail(-this.#detailRows);
		else if (matchesSelectPageDown(data)) this.#scrollDetail(this.#detailRows);
		else if (matchesKey(data, "home")) this.#detailScroll = 0;
		else if (matchesKey(data, "end")) this.#scrollDetail(Number.MAX_SAFE_INTEGER);
		else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = "list";
			this.#tabBar.handleInput(data);
		}
	}

	#handleSearchInput(data: string): void {
		const kb = getKeybindings();
		if (matchesSelectCancel(data)) {
			this.#focus = "list";
			if (!this.#search) this.#searchInput.setValue("");
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const query = this.#searchInput.getValue().trim();
			if (query) this.#runSearch(query);
			else this.#clearSearch();
			this.#focus = "list";
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			this.#regex = !this.#regex;
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = "list";
			this.#tabBar.handleInput(data);
			return;
		}
		this.#searchInput.handleInput(data);
	}

	/** Clicks on a list row select it; a double click opens its detail. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (!this.#isCurrent()) return;
		if (event.type !== "select" && event.type !== "activate") return;
		if (event.key.slice(event.key.lastIndexOf("/") + 1) !== this.#listKey()) return;
		this.#select(event.item);
		if (event.type === "activate") this.#focus = "detail";
		this.#source.requestRender();
	}

	/** Switch to the Archive tab with the search field focused. */
	openSearch(): void {
		if (!this.#isCurrent()) return;
		if (this.#tab !== "archive") this.#tabBar.selectTab("archive");
		this.#searchInput.setValue(this.#search?.query ?? this.#searchInput.getValue());
		this.#focus = "search";
	}

	#showTab(tab: ContextInspectorTab): void {
		if (tab === this.#tab) return;
		this.#tab = tab;
		this.#focus = "list";
		this.#detailScroll = 0;
	}

	dispose(): void {
		this.#closed = true;
		this.#search?.controller.abort();
		this.#search = undefined;
	}

	#isCurrent(): boolean {
		if (this.#closed) return false;
		if (this.#source.isCurrent?.() !== false) return true;
		this.#close();
		return false;
	}

	#close(): void {
		if (this.#closed) return;
		this.dispose();
		this.#source.close();
	}

	#runSearch(query: string): void {
		this.#search?.controller.abort();
		const state: SearchState = { query, regex: this.#regex, controller: new AbortController() };
		this.#search = state;
		this.#detailMemo = undefined;
		this.#native = undefined;
		this.#selected.search = undefined;
		this.#listOffset.search = 0;
		this.#detailScroll = 0;
		this.#source.search(query, state.regex, state.controller.signal).then(
			result => {
				if (this.#search !== state || !this.#isCurrent()) return;
				state.result = result;
				this.#selected.search = result.hits[0]?.item.id;
				this.#source.requestRender();
			},
			(error: unknown) => {
				if (this.#search !== state || !this.#isCurrent()) return;
				state.error = error instanceof Error ? error.message : String(error);
				this.#source.requestRender();
			},
		);
	}

	#clearSearch(): void {
		this.#search?.controller.abort();
		this.#search = undefined;
		this.#searchInput.setValue("");
		this.#detailScroll = 0;
	}

	// ─────────────────────────────── lists ───────────────────────────────

	#listKey(): ListKey {
		return this.#tab === "archive" && this.#search ? "search" : this.#tab;
	}

	#entries(key: ListKey): readonly ListEntry[] {
		switch (key) {
			case "blocks":
				return this.#snapshot.blocks.map(block => this.#blockEntry(block));
			case "history":
				return this.#snapshot.revisions.toReversed().map(revision => this.#revisionEntry(revision));
			case "archive":
				return this.#snapshot.archive.toReversed().map(entry => this.#archiveEntry(entry));
			case "search":
				return (this.#search?.result?.hits ?? []).map(hit => this.#hitEntry(hit));
		}
	}

	/** The visible list and its selected entry (the first when the selection is unset). */
	#current(): { key: ListKey; entries: readonly ListEntry[]; selected: ListEntry | undefined; index: number } {
		const key = this.#listKey();
		const entries = this.#entries(key);
		let index = entries.findIndex(entry => entry.id === this.#selected[key]);
		if (index < 0) index = entries.length > 0 ? 0 : -1;
		return { key, entries, selected: entries[index], index };
	}

	#select(id: string): void {
		const key = this.#listKey();
		if (this.#selected[key] === id) return;
		this.#selected[key] = id;
		this.#detailScroll = 0;
	}

	#move(delta: number): void {
		const { entries, index } = this.#current();
		if (entries.length === 0) return;
		const next = Math.max(0, Math.min(entries.length - 1, index + delta));
		this.#select(entries[next].id);
	}

	#blockEntry(block: ContextInspectorBlock): ListEntry {
		const flag = blockFlag(block);
		return {
			id: block.id,
			render: (selected, width) => {
				const accent = selected ? "accent" : undefined;
				const head =
					cursor(selected) +
					cell(block.id, 6, accent) +
					cell(blockRole(block), 10, selected ? "accent" : "muted") +
					cell(formatNumber(block.tokens), 6, selected ? "accent" : "muted", "end") +
					"  " +
					cell(flag, 10, flag ? FLAG_COLOR[flag] : undefined);
				const room = width - visibleWidth(head) - 1;
				return room > 4 ? `${head} ${theme.fg("dim", truncateToWidth(firstLine(block.text), room))}` : head;
			},
			describe: () =>
				item(block.id, {
					label: [span(block.id, "accent"), span(`  ${blockRole(block)}`, "muted")],
					value: [
						...(flag ? [span(`${flag}  `, FLAG_COLOR[flag])] : []),
						span(formatNumber(block.tokens), "muted"),
					],
					title: firstLine(block.text),
				}),
		};
	}

	#revisionEntry(revision: ContextInspectorRevision): ListEntry {
		const delta = revision.tokensAfter - revision.tokensBefore;
		const deltaColor: ThemeColor = delta < 0 ? "success" : delta > 0 ? "warning" : "dim";
		const tokens = `${formatNumber(revision.tokensBefore)} → ${formatNumber(revision.tokensAfter)}`;
		return {
			id: revision.id,
			render: selected =>
				cursor(selected) +
				cell(revision.id, 10, selected ? "accent" : undefined) +
				cell(revision.cause, 12, "muted") +
				cell(tokens, 14, "muted") +
				cell(signedTokens(delta), 7, deltaColor, "end") +
				theme.fg("dim", `  ${clockTime(revision.timestamp)}`),
			describe: () =>
				item(revision.id, {
					label: [span(revision.id, "accent"), span(`  ${revision.cause}`, "muted")],
					value: [span(`${tokens}  `, "muted"), span(signedTokens(delta), deltaColor)],
					title: clockTime(revision.timestamp),
				}),
		};
	}

	#archiveEntry(entry: ContextInspectorArchiveItem): ListEntry {
		return {
			id: entry.id,
			render: (selected, width) => {
				const head =
					cursor(selected) +
					cell(entry.id, 13, selected ? "accent" : undefined) +
					cell(archiveWho(entry), 14, "muted") +
					cell(formatNumber(entry.tokens), 6, "muted", "end") +
					"  ";
				return head + theme.fg("dim", truncateToWidth(clean(entry.label), Math.max(0, width - visibleWidth(head))));
			},
			describe: () =>
				item(entry.id, {
					label: [span(entry.id, "accent"), span(`  ${archiveWho(entry)}`, "muted")],
					value: [span(formatNumber(entry.tokens), "muted")],
					title: clean(entry.label),
				}),
		};
	}

	#hitEntry(hit: ContextInspectorSearchHit): ListEntry {
		const score =
			hit.p !== undefined ? hit.p.toFixed(2) : hit.lexicalRank !== undefined ? `#${hit.lexicalRank}` : "·";
		const scoreColor: ThemeColor = hit.p !== undefined && hit.p >= STRONG_RELEVANCE ? "success" : "muted";
		return {
			id: hit.item.id,
			render: (selected, width) => {
				const head =
					cursor(selected) +
					cell(score, 5, scoreColor, "end") +
					"  " +
					cell(hit.item.id, 13, selected ? "accent" : undefined) +
					cell(archiveWho(hit.item), 14, "muted");
				return (
					head + theme.fg("dim", truncateToWidth(clean(hit.item.label), Math.max(0, width - visibleWidth(head))))
				);
			},
			describe: () =>
				item(hit.item.id, {
					label: [
						span(`${score}  `, scoreColor),
						span(hit.item.id, "accent"),
						span(`  ${archiveWho(hit.item)}`, "muted"),
					],
					title: clean(hit.item.label),
				}),
		};
	}

	// ─────────────────────────────── detail ──────────────────────────────

	#diff(revision: string): ContextInspectorDiff | Error {
		let diff = this.#diffs.get(revision);
		if (!diff) {
			try {
				diff = this.#source.diff(revision);
			} catch (error) {
				diff = error instanceof Error ? error : new Error(String(error));
			}
			this.#diffs.set(revision, diff);
		}
		return diff;
	}

	#detail(width: number): Detail | undefined {
		const { key, selected } = this.#current();
		if (!selected) return undefined;
		const memoKey = `${key}\0${selected.id}`;
		if (this.#detailMemo?.key === memoKey && this.#detailMemo.width === width) return this.#detailMemo.detail;
		const detail = this.#buildDetail(key, selected.id, width);
		this.#detailMemo = { key: memoKey, width, detail };
		return detail;
	}

	#buildDetail(key: ListKey, id: string, width: number): Detail {
		if (key === "blocks") {
			const block = this.#snapshot.blocks.find(entry => entry.id === id)!;
			const facts = [
				block.protectedKind ? theme.fg("warning", `protected · ${block.protectedKind}`) : undefined,
				block.role === "clmNote" ? theme.fg("customMessageLabel", "model-authored note") : undefined,
				block.opaque ? "opaque · keep whole or delete" : undefined,
				`revision ${shortRevision(this.#snapshot.revision)}`,
			].filter(fact => fact !== undefined);
			return {
				head: [
					theme.fg("accent", `${block.id} · ${blockRole(block)} · ${formatNumber(block.tokens)} tok`),
					theme.fg("dim", facts.join(theme.fg("dim", " · "))),
				],
				body: ["", ...wrapPlain(block.text, width, "muted")],
			};
		}
		if (key === "history") {
			const revision = this.#snapshot.revisions.find(entry => entry.id === id)!;
			const delta = revision.tokensAfter - revision.tokensBefore;
			const diff = this.#diff(revision.id);
			const head = [
				theme.fg(
					"accent",
					`${shortRevision(diff instanceof Error ? (revision.previousRevision ?? "?") : diff.before)} → ${revision.id}`,
				) + theme.fg(delta < 0 ? "success" : delta > 0 ? "warning" : "dim", `  ${signedTokens(delta)}`),
				theme.fg(
					"dim",
					`${revision.cause} · ${clockTime(revision.timestamp)} · ${revision.tokensBefore.toLocaleString("en-US")} → ${revision.tokensAfter.toLocaleString("en-US")} tok`,
				),
			];
			if (diff instanceof Error) return { head, body: ["", ...wrapPlain(diff.message, width, "error")] };
			if (diff.changes.length === 0) return { head, body: ["", theme.fg("dim", "No block changes")] };
			const body = [""];
			for (const { op, block } of diff.changes) {
				const glyph = op === "-" ? theme.fg("toolDiffRemoved", "− ") : theme.fg("toolDiffAdded", "+ ");
				const summary = `${block.id.padEnd(6)}${blockRole(block).padEnd(10)}${formatNumber(block.tokens).padStart(6)}  ${firstLine(block.text)}`;
				body.push(glyph + theme.fg("dim", truncateToWidth(summary, Math.max(1, width - 2))));
			}
			return { head, body };
		}
		const hit = key === "search" ? this.#search?.result?.hits.find(entry => entry.item.id === id) : undefined;
		const entry = hit?.item ?? this.#snapshot.archive.find(candidate => candidate.id === id)!;
		const facts: string[] = [];
		if (hit) {
			const tags: string[] = [];
			if (hit.p !== undefined) tags.push(`relevance p=${hit.p.toFixed(2)}`);
			if (hit.lexicalRank !== undefined) tags.push(`lexical #${hit.lexicalRank}`);
			else if (hit.origin === "scan") tags.push("label scan");
			else if (hit.origin === "superseder") tags.push("supersedes a match");
			if (tags.length > 0) facts.push(tags.join(", "));
		}
		const time = Number.isFinite(entry.timestamp) ? new Date(entry.timestamp).toTimeString().slice(0, 8) : undefined;
		if (time) facts.push(time);
		facts.push(entry.inContext ? "in context" : "out of context");
		if (entry.supersededBy) facts.push(`superseded by ${entry.supersededBy}`);
		if (entry.occurrences > 1) facts.push(`seen ${entry.occurrences}×`);
		if (entry.truncated) facts.push("truncated");
		if (entry.failed) facts.push("failed");
		const kind = entry.toolName && entry.kind !== "subagent" ? `${entry.kind}:${entry.toolName}` : entry.kind;
		return {
			head: [
				theme.fg("accent", `${entry.id} · ${kind} t${entry.turn} · ${formatNumber(entry.tokens)} tok`),
				theme.fg("dim", facts.join(" · ")),
			],
			body: ["", ...numberedLines(entry.text, width)],
		};
	}

	#scrollDetail(delta: number): void {
		this.#detailScroll = Math.max(0, this.#detailScroll + delta);
	}

	/** Exactly `rows` detail rows: pinned head, then a window over the body. */
	#detailWindow(width: number, rows: number): string[] {
		const detail = this.#detail(width);
		if (!detail) return [];
		const bodyRows = Math.max(0, rows - detail.head.length);
		this.#detailRows = Math.max(1, bodyRows);
		const maxScroll = Math.max(0, detail.body.length - bodyRows);
		this.#detailScroll = Math.min(this.#detailScroll, maxScroll);
		const head = [...detail.head];
		if (maxScroll > 0) {
			const first = this.#detailScroll + 1;
			const last = Math.min(detail.body.length, this.#detailScroll + bodyRows);
			const position = theme.fg(
				this.#focus === "detail" ? "accent" : "dim",
				`${first}–${last}/${detail.body.length}`,
			);
			head[head.length - 1] = `${head.at(-1)}${theme.fg("dim", " · ")}${position}`;
		}
		return [
			...head.map(line => truncateToWidth(line, width)),
			...detail.body.slice(this.#detailScroll, this.#detailScroll + bodyRows),
		].slice(0, rows);
	}

	// ─────────────────────────────── frame ───────────────────────────────

	#headerText(): string {
		const snapshot = this.#snapshot;
		const parts = [
			shortRevision(snapshot.revision),
			`${snapshot.blocks.length} blocks`,
			`${snapshot.estimatedRequestTokens.toLocaleString("en-US")} tok`,
		];
		let header = theme.fg("dim", parts.join(" · "));
		const soft = snapshot.softLimitTokens;
		if (soft && soft > 0) {
			const percent = Math.round((snapshot.estimatedRequestTokens / soft) * 100);
			const color: ThemeColor = percent >= 100 ? "error" : percent >= 80 ? "warning" : "dim";
			header += theme.fg("dim", " · ") + theme.fg(color, `${percent}% of soft limit`);
		}
		return `${header}${theme.fg("dim", ` · ${snapshot.archive.length} archived`)}`;
	}

	/** Search field and status rows above the Archive list while a search is open. */
	#searchRows(width: number): string[] {
		if (this.#tab !== "archive" || (this.#focus !== "search" && !this.#search)) return [];
		const icon = theme.fg("accent", theme.symbol("icon.search"));
		const mode = this.#regex ? theme.fg("warning", " regex") : "";
		let field: string;
		if (this.#focus === "search") {
			const inputWidth = Math.max(4, width - visibleWidth(mode) - 4);
			field = `${theme.bold(this.#searchInput.render(inputWidth)[0] ?? "")}${mode}`;
		} else field = `${this.#search?.query ?? ""}${mode}`;
		return [truncateToWidth(` ${icon} ${field}`, width), truncateToWidth(` ${this.#searchStatus()}`, width), ""];
	}

	#searchStatus(): string {
		const search = this.#search;
		if (!search) return theme.fg("dim", `${formatKeyHint("enter")} to search · ${formatKeyHint("ctrl+r")} regex`);
		if (search.error) return theme.fg("error", search.error);
		const result = search.result;
		if (!result) return theme.fg("dim", search.regex ? "Filtering…" : "Ranking…");
		const hits = `${result.hits.length} ${result.hits.length === 1 ? "hit" : "hits"}`;
		if (result.mode === "regex") return theme.fg("dim", `${hits} of ${result.matches} · regex, newest first`);
		if (result.mode === "lexical") {
			return (
				theme.fg("dim", `${hits} · lexical`) + theme.fg("warning", ` (${result.fallbackReason ?? "no rerank"})`)
			);
		}
		const judge = result.judge;
		const usage = judge ? ` · $${judge.costUsd.toFixed(4)} · ${(judge.ms / 1000).toFixed(1)}s` : "";
		return theme.fg("dim", `${hits} · Jev · ${result.relevant ?? 0} of ${result.matches} relevant${usage}`);
	}

	/** Exactly `rows` list rows (search rows first in the Archive tab). */
	#listWindow(width: number, rows: number): string[] {
		const out = this.#searchRows(width);
		const { key, entries, index } = this.#current();
		const room = Math.max(0, rows - out.length);
		if (entries.length === 0) {
			out.push(theme.fg("dim", `   ${this.#emptyText(key)}`));
			return out.slice(0, rows);
		}
		const start = windowStart(this.#listOffset[key] ?? 0, Math.max(0, index), room, entries.length);
		this.#listOffset[key] = start;
		this.#listRows = Math.max(1, room);
		for (let i = start; i < Math.min(entries.length, start + room); i++) {
			out.push(truncateToWidth(entries[i].render(i === index, width), width));
		}
		return out.slice(0, rows);
	}

	#emptyText(key: ListKey): string {
		switch (key) {
			case "blocks":
				return "The context is empty";
			case "history":
				return "No context revisions on this branch yet";
			case "archive":
				return "The archive is empty";
			case "search":
				return this.#search?.result || this.#search?.error ? "No matching items" : "";
		}
	}

	#footerText(): string {
		const move = editorKeys("tui.select.up", "tui.select.down");
		const confirm = editorKey("tui.select.confirm");
		const cancel = editorKey("tui.select.cancel");
		const tab = formatKeyHint("tab");
		if (this.#focus === "search") {
			return `Type to search · ${confirm} rank · ${formatKeyHint("ctrl+r")} regex · ${cancel} back`;
		}
		if (this.#focus === "detail") {
			return `${move} scroll · ${editorKeys("tui.select.pageUp", "tui.select.pageDown")} page · ${confirm}/${cancel} back to list`;
		}
		const view = this.#tab === "blocks" ? "view block" : this.#tab === "history" ? "view diff" : "view item";
		const parts = [`${move} select`, `${confirm} ${view}`];
		if (this.#tab === "blocks") parts.push("d diff");
		parts.push(`${tab} tabs`, this.#tab === "archive" ? "/ search" : "/ search archive");
		parts.push(this.#tab === "archive" && this.#search ? `${cancel} clear search` : `${cancel} close`);
		return parts.join(" · ");
	}

	/**
	 * Fullscreen frame: title, tabs, header line, then the list beside its
	 * detail (wide) or above it (narrow), and a key-hint footer.
	 */
	render(width: number): readonly string[] {
		if (!this.#isCurrent()) return [];
		const height = Math.max(14, process.stdout.rows || 40);
		const inner = Math.max(1, width - 4);
		const tabLines = this.#tabBar.render(inner);
		// Top border, tabs, divider, header, section rule, divider, footer, bottom border.
		const bodyRows = Math.max(6, height - tabLines.length - 7);
		const out = [topBorder(width, "Context"), ...tabLines.map(line => row(line, width)), divider(width)];
		out.push(row(truncateToWidth(` ${this.#headerText()}`, inner), width));
		if (width >= SPLIT_MIN_WIDTH) {
			const listWidth = Math.min(LIST_MAX_WIDTH, Math.floor((width - 7) / 2));
			const list = this.#listWindow(listWidth, bodyRows);
			const detail = this.#detailWindow(splitBodyWidth(width, listWidth), bodyRows);
			out.push(dividerOpenSplit(width, listWidth));
			for (let i = 0; i < bodyRows; i++) out.push(splitRow(list[i] ?? "", detail[i] ?? "", width, listWidth));
			out.push(dividerSplit(width, listWidth));
		} else {
			const listRows = Math.max(3, Math.floor(bodyRows * STACKED_LIST_SHARE));
			const list = this.#listWindow(inner, listRows);
			const detail = this.#detailWindow(inner - 3, bodyRows - listRows - 1);
			out.push(divider(width));
			for (let i = 0; i < listRows; i++) out.push(row(list[i] ?? "", width));
			out.push(row(theme.fg("dim", `   ${"─".repeat(Math.max(0, inner - 6))}`), width));
			for (let i = 0; i < bodyRows - listRows - 1; i++) {
				const line = detail[i];
				out.push(row(line ? `   ${line}` : "", width));
			}
			out.push(divider(width));
		}
		out.push(row(theme.fg("dim", truncateToWidth(this.#footerText(), inner)), width), bottomBorder(width));
		return out;
	}

	// ─────────────────────────────── native ──────────────────────────────

	/**
	 * Root card `omp.overlay.context`: tabs, the header line, the archive search
	 * field, a selectable list beside the selected entry's detail, key hints.
	 */
	describe(_cx: DescribeContext): NativeNode {
		if (!this.#isCurrent()) return EMPTY_NODE;
		const { key, entries, selected } = this.#current();
		const search = this.#search;
		const signature = [
			this.#tab,
			key,
			selected?.id,
			this.#focus,
			this.#regex,
			search?.query,
			search?.result ? "done" : search?.error ? "error" : search ? "pending" : "",
		].join("\0");
		if (this.#native?.signature === signature) return this.#native.node;
		const children: NativeChild[] = [this.#tabBar, text(styledSpans(this.#headerText()))];
		if (this.#tab === "archive" && (this.#focus === "search" || search)) {
			children.push(
				node(
					"row",
					{ gap: "xs", align: "center", role: "omp.context.search" },
					[
						text([span(theme.symbol("icon.search"), "accent")]),
						this.#focus === "search"
							? col([this.#searchInput], { grow: 1 })
							: text([span(search?.query ?? "")], { grow: 1 }),
						text(styledSpans(this.#searchStatus()), {
							wrap: "none",
						}),
					],
					"search",
				),
			);
		}
		const detail = selected ? this.#detail(80) : undefined;
		children.push(
			node(
				"row",
				{ gap: "md", grow: 1 },
				[
					selectList(
						key,
						entries.map(entry => entry.describe()),
						{ selected: selected?.id ?? null, empty: this.#emptyText(key) },
					),
					col(
						detail
							? [
									...detail.head.map(line => text(styledSpans(line), { truncate: "end", wrap: "none" })),
									text([span(this.#detailText(key, selected!.id))], { role: "omp.context.detail" }),
								]
							: [],
						{ grow: 1, basis: 0 },
					),
				],
				"body",
			),
		);
		children.push(hintsRow(this.#nativeHints()));
		const described = overlayCard("omp.overlay.context", "Context", children);
		this.#native = { signature, node: described };
		return described;
	}

	/** Unwrapped detail body for the native pane, which wraps and scrolls on its own. */
	#detailText(key: ListKey, id: string): string {
		if (key === "blocks") return clean(this.#snapshot.blocks.find(block => block.id === id)?.text ?? "");
		if (key === "history") {
			const diff = this.#diff(id);
			if (diff instanceof Error) return diff.message;
			return diff.changes
				.map(
					({ op, block }) =>
						`${op === "-" ? "−" : "+"} ${block.id}  ${blockRole(block)}  ${formatNumber(block.tokens)}  ${firstLine(block.text)}`,
				)
				.join("\n");
		}
		const entry =
			this.#search?.result?.hits.find(hit => hit.item.id === id)?.item ??
			this.#snapshot.archive.find(candidate => candidate.id === id);
		return clean(entry?.text ?? "");
	}

	#nativeHints(): (NativeHint | undefined)[] {
		if (this.#focus === "search") {
			return [
				{ keys: [], label: "type to search" },
				actionHint("tui.select.confirm", "rank"),
				{ keys: ["ctrl+r"], label: "regex" },
				actionHint("tui.select.cancel", "back"),
			];
		}
		const hints: (NativeHint | undefined)[] = [
			actionHint(["tui.select.up", "tui.select.down"], this.#focus === "detail" ? "scroll" : "select"),
			{ keys: ["tab"], label: "tabs" },
			{ keys: ["/"], label: "search archive" },
		];
		if (this.#tab === "blocks") hints.push({ keys: ["d"], label: "diff" });
		hints.push(actionHint("tui.select.cancel", this.#tab === "archive" && this.#search ? "clear search" : "close"));
		return hints;
	}
}
