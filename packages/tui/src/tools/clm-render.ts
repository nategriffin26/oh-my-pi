/**
 * Transcript renderers for `read context://…`: the CLM context document (block table), its
 * status (key/value list over a soft-limit gauge), revision history and diffs, and the archive
 * (listing, verbatim items, and ranked recall with relevance bars).
 *
 * The executing tool attaches {@link ClmReadDetails}; the model-facing text is never parsed here.
 */
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { Component } from "../tui";
import { Ellipsis, truncateToWidth, wrapTextWithAnsi } from "../utils";
import {
	createCachedComponent,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	markFramedBlockComponent,
	type OutputBlockOptions,
	outputBlockContentWidth,
	PREVIEW_LIMITS,
	renderCodeCell,
	renderOutputBlock,
	replaceTabs,
} from "../render";
import type { Theme, ThemeColor } from "../theme/theme";
import { code, col, compact, keyed, kv, node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import type { NativeToolView, RenderResultOptions } from "./renderer";
import { scoreColor, scoreGauge, scoreTone } from "./find";
import { statsText } from "./native-view";

/** One envelope block: the row a document/revision read shows for it. */
export interface ClmBlockRow {
	id: string;
	role: string;
	/** Original 1-based envelope line; persisted pages retain their source position. */
	line?: number;
	/** Estimated tokens of the block's text. */
	tokens: number;
	protected?: true;
	opaque?: true;
	/** One line of the block text, whitespace-collapsed. */
	preview: string;
}

/** `context://self` (and its pages) or `context://self/revision/<id>`. */
export interface ClmDocumentReadDetails {
	kind: "document" | "revision";
	revision: string;
	snapshotId: string;
	/** Sum of the block token estimates. */
	tokens: number;
	/** Configured soft limit when the session reports a budget. */
	softLimitTokens?: number;
	/** Total document blocks when blocks carries only the formatted page. */
	blockCount?: number;
	blocks: ClmBlockRow[];
}

/** `context://self/status`. */
export interface ClmStatusReadDetails {
	kind: "status";
	revision: string;
	staged: string | null;
	estimatedRequestTokens: number;
	localRequestTokens?: number;
	localExact?: boolean;
	safetyMarginTokens?: number;
	generationReserveTokens?: number;
	softLimitTokens?: number;
	capacityTokens?: number;
	remainingTokens?: number;
	contextWindow: number | null;
	lastReceipt: string | null;
}

/** One published revision on the branch. */
export interface ClmHistoryRow {
	revision: string;
	previousRevision?: string;
	cause: string;
	/** ISO timestamp of the projection entry. */
	timestamp: string;
	tokensBefore: number;
	tokensAfter: number;
}

/** `context://self/history`. */
export interface ClmHistoryReadDetails {
	kind: "history";
	revisions: ClmHistoryRow[];
}

/** `context://self/diff/<id>[/current]`. */
export interface ClmDiffReadDetails {
	kind: "diff";
	before: string;
	after: string;
}

/** One archive item as listing, item, and recall rows show it. */
export interface ClmArchiveRow {
	id: string;
	kind: string;
	toolName?: string;
	label: string;
	tokens: number;
	/** First occurrence, epoch ms. */
	timestamp: number;
	turn: number;
	inContext?: true;
	supersededBy?: string;
	truncated?: true;
	failed?: true;
}

/** `context://{self,parent}/archive` (manifest page). */
export interface ClmArchiveListReadDetails {
	kind: "archive";
	total: number;
	inContext: number;
	superseded: number;
	tokens: number;
	/** Zero-based index of the first listed item. */
	offset: number;
	items: ClmArchiveRow[];
}

/** `context://{self,parent}/archive/<id>`. */
export interface ClmArchiveItemReadDetails {
	kind: "archive-item";
	item: ClmArchiveRow;
	/** Lines in the whole item. */
	lines: number;
}

/** One ranked recall hit. */
export interface ClmSearchHitRow extends ClmArchiveRow {
	/** Judge probability (Jev mode). */
	p?: number;
	/** BM25 rank among matching items. */
	lexicalRank?: number;
	/** How the item entered the candidates: lexical shortlist, a superseding item, or the Jev label scan. */
	origin?: "lexical" | "superseder" | "scan";
	/** The first excerpt line the model saw for this hit. */
	preview: string;
	/** Item line number of {@link preview}. */
	line?: number;
}

/** `context://{self,parent}/archive?q=`. */
export interface ClmArchiveSearchReadDetails {
	kind: "archive-search";
	query: string;
	mode: "jev" | "lexical" | "regex";
	/** Why ranking stayed lexical. */
	fallbackReason?: string;
	/** Items in the searched archive. */
	total: number;
	/** Items matching lexically or the regex. */
	matches: number;
	/** Lexical candidates the judge saw. */
	shortlist: number;
	/** Superseding items pulled into the candidates. */
	superseders: number;
	/** Items the Jev label scan looked at, and the eligible total when it ran. */
	scanned?: number;
	scanTotal?: number;
	/** Items judged at or above {@link threshold}. */
	relevant?: number;
	threshold: number;
	judge?: { requests: number; tokens: number; costUsd: number; ms: number };
	/** Best first (regex: newest first). */
	hits: ClmSearchHitRow[];
}

/** Structured view of one `context://` read, attached to the read tool's details. */
export type ClmReadDetails =
	| ClmDocumentReadDetails
	| ClmStatusReadDetails
	| ClmHistoryReadDetails
	| ClmDiffReadDetails
	| ClmArchiveListReadDetails
	| ClmArchiveItemReadDetails
	| ClmArchiveSearchReadDetails;

/** Displayed slice of a paged read, as the read tool records it. */
export interface ClmReadDisplay {
	text: string;
	startLine: number;
	lineNumbers?: Array<number | null>;
}

/** Rows (blocks, items, hits, fields) shown before expansion. */
const COLLAPSED_ROWS = 5;
/** Cells in a recall hit's relevance bar. */
const RELEVANCE_CELLS = 10;
/** Collapsed status fields: the estimate and the three capacity lines. */
const STATUS_COLLAPSED_FIELDS = 4;
const KEY_WIDTH = 24;

const exact = (value: number): string => value.toLocaleString("en-US");

function clock(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return "--:--";
	const date = new Date(epochMs);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function itemKind(row: ClmArchiveRow): string {
	return row.toolName && row.kind !== "subagent" ? row.toolName : row.kind;
}

/**
 * Envelope lines (1-based) a document page displayed map onto block indices: line 1 is the
 * envelope head, line `i + 2` is block `i`. A full read covers every block.
 */
function pageBlocks(details: ClmDocumentReadDetails, display: ClmReadDisplay | undefined): ClmBlockRow[] {
	if (!display) return details.blocks;
	const lines = new Set(
		display.lineNumbers?.filter((line): line is number => line !== null) ??
			Array.from({ length: display.text.split("\n").length }, (_, index) => display.startLine + index),
	);
	return details.blocks.filter((block, index) => lines.has(block.line ?? index + 2));
}

/** Whether the read displayed only part of the resource. */
function partialRange(display: ClmReadDisplay | undefined, total: number): string | undefined {
	if (!display) return undefined;
	const lines = display.lineNumbers?.filter((line): line is number => line !== null);
	const first = lines?.[0] ?? display.startLine;
	const last = lines?.at(-1) ?? first + display.text.split("\n").length - 1;
	if (first <= 1 && last >= total) return undefined;
	return `lines ${first}–${last}`;
}

interface Frame {
	title: string;
	meta: readonly string[];
	sections: OutputBlockOptions["sections"];
}

/** A framed read card re-rendered on width or expand changes, matching the generic read cell's frame. */
function framedCard(
	options: RenderResultOptions,
	theme: Theme,
	build: (contentWidth: number, expanded: boolean) => Frame,
): Component {
	return markFramedBlockComponent(
		createCachedComponent(
			() => Boolean(options.expanded),
			(width, expanded) => {
				const frame = build(outputBlockContentWidth(width), expanded);
				return renderOutputBlock(
					{
						header: `${formatStatusIcon("done", theme)} ${theme.fg("toolTitle", replaceTabs(frame.title))}`,
						headerMeta: frame.meta.length > 0 ? theme.fg("dim", frame.meta.join(theme.sep.dot)) : undefined,
						state: "success",
						sections: frame.sections,
						width,
					},
					theme,
				);
			},
		),
	);
}

/** Truncate each composed row to the frame's inner width so table rows never wrap. */
function fit(lines: readonly string[], width: number): string[] {
	return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
}

function moreLine(hidden: number, itemType: string, expanded: boolean, theme: Theme): string[] {
	if (hidden <= 0) return [];
	const hint = formatExpandHint(theme, expanded, true);
	return [theme.fg("dim", `${formatMoreItems(hidden, itemType)}${hint ? ` ${hint}` : ""}`)];
}

function capped<T>(rows: readonly T[], expanded: boolean): { shown: readonly T[]; hidden: number } {
	const shown = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
	return { shown, hidden: rows.length - shown.length };
}

function blockFlags(block: ClmBlockRow): string {
	return [block.protected && "protected", block.opaque && "opaque"].filter(Boolean).join(" ");
}

function blockTable(blocks: readonly ClmBlockRow[], width: number, theme: Theme): string[] {
	const idWidth = Math.max(3, ...blocks.map(block => block.id.length));
	const roleWidth = Math.min(12, Math.max(4, ...blocks.map(block => block.role.length)));
	const flagWidth = Math.max(0, ...blocks.map(block => blockFlags(block).length));
	return fit(
		blocks.map(block => {
			const flags = blockFlags(block);
			const flagCell = flagWidth === 0 ? "" : `  ${flags.padEnd(flagWidth)}`;
			return [
				theme.fg("accent", block.id.padEnd(idWidth)),
				theme.fg("muted", truncateToWidth(block.role, roleWidth, Ellipsis.Unicode).padEnd(roleWidth)),
				theme.fg("muted", formatNumber(block.tokens).padStart(6)),
				block.protected ? theme.fg("warning", flagCell) : theme.fg("dim", flagCell),
			]
				.join("  ")
				.concat(`  ${theme.fg("dim", replaceTabs(block.preview))}`);
		}),
		width,
	);
}

/** Size line first (it must survive narrow widths), then the revision/snapshot identity line. */
function documentSummary(details: ClmDocumentReadDetails, page: string | undefined, shown: number): string[] {
	const count = details.blockCount ?? details.blocks.length;
	const size = [String(count) + (count === 1 ? " block" : " blocks"), `${exact(details.tokens)} tok`];
	if (details.softLimitTokens)
		size.push(`${Math.round((details.tokens / details.softLimitTokens) * 100)}% of soft limit`);
	if (page) size.push(`${page} (${shown} ${shown === 1 ? "block" : "blocks"})`);
	return [size.join(" · "), `revision ${details.revision} · snapshot ${details.snapshotId}`];
}

function renderDocument(
	path: string,
	details: ClmDocumentReadDetails,
	display: ClmReadDisplay | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const page = partialRange(display, (details.blockCount ?? details.blocks.length) + 2);
	const blocks = pageBlocks(details, display);
	return framedCard(options, theme, (width, expanded) => {
		const { shown, hidden } = capped(blocks, expanded);
		return {
			title: `Read ${path}`,
			meta: [],
			sections: [
				{
					lines: [
						...fit(
							documentSummary(details, page, blocks.length).map(line => theme.fg("dim", line)),
							width,
						),
						...blockTable(shown, width, theme),
						...moreLine(hidden, "block", expanded, theme),
					],
				},
			],
		};
	});
}

/** The status line's gauge vocabulary: box-line cells, used in accent/warning/error, the soft limit as its tick. */
function statusGauge(details: ClmStatusReadDetails, cells: number, theme: Theme): string[] {
	const scale = details.capacityTokens || details.contextWindow || 0;
	if (scale <= 0 || cells < 8) return [];
	const estimate = details.estimatedRequestTokens;
	const soft = details.softLimitTokens ?? 0;
	const level: ThemeColor =
		details.capacityTokens && estimate >= details.capacityTokens
			? "error"
			: soft > 0 && estimate >= soft
				? "warning"
				: "borderAccent";
	const used = Math.min(cells, Math.max(estimate > 0 ? 1 : 0, Math.round((estimate / scale) * cells)));
	const tick = soft > 0 && soft < scale ? Math.min(cells - 1, Math.round((soft / scale) * cells)) : -1;
	const horizontal = theme.boxRound.horizontal;
	const before = Math.min(used, tick < 0 ? cells : tick);
	const fill = (count: number, color: ThemeColor) => (count > 0 ? theme.fg(color, horizontal.repeat(count)) : "");
	let bar = fill(before, level);
	if (tick < 0) bar += fill(cells - before, "border");
	else
		bar +=
			fill(tick - before, "border") +
			theme.fg(estimate >= soft ? "warning" : "muted", theme.symbol("context.compaction")) +
			fill(Math.max(0, used - tick - 1), level) +
			fill(cells - Math.max(tick + 1, used), "border");
	const end = `${formatNumber(scale)} ${details.capacityTokens ? "cap" : "window"}`;
	if (tick < 0) return [bar, theme.fg("dim", end.padStart(cells))];
	const softLabel = `${formatNumber(soft)} soft`;
	const fitsAfter = tick + softLabel.length + 1 + end.length <= cells;
	const softStart = fitsAfter ? tick : Math.max(0, tick + 1 - softLabel.length);
	const gap = cells - softStart - softLabel.length - end.length;
	const marks =
		gap >= 1
			? `${" ".repeat(softStart)}${softLabel}${" ".repeat(gap)}${end}`
			: `${" ".repeat(softStart)}${softLabel}`;
	return [bar, theme.fg("dim", marks)];
}

function statusFields(details: ClmStatusReadDetails, theme: Theme): string[] {
	const soft = details.softLimitTokens;
	const estimate = details.estimatedRequestTokens;
	const level: ThemeColor =
		details.capacityTokens && estimate >= details.capacityTokens
			? "error"
			: soft && estimate >= soft
				? "warning"
				: "success";
	const share = soft ? ` (${Math.round((estimate / soft) * 100)}% of soft limit)` : "";
	const fields: [string, string | undefined, ThemeColor?][] = [
		["estimatedRequestTokens", `${exact(estimate)}${share}`, level],
		["softLimitTokens", soft === undefined ? undefined : exact(soft)],
		["capacityTokens", details.capacityTokens === undefined ? undefined : exact(details.capacityTokens)],
		["remainingTokens", details.remainingTokens === undefined ? undefined : exact(details.remainingTokens)],
		[
			"localRequestTokens",
			details.localRequestTokens === undefined
				? undefined
				: `${exact(details.localRequestTokens)}${details.localExact ? " (exact)" : " (approximate)"}`,
		],
		["safetyMarginTokens", details.safetyMarginTokens === undefined ? undefined : exact(details.safetyMarginTokens)],
		[
			"generationReserveTokens",
			details.generationReserveTokens === undefined ? undefined : exact(details.generationReserveTokens),
		],
		["contextWindow", details.contextWindow === null ? undefined : exact(details.contextWindow)],
		["revision", details.revision],
		["staged", details.staged ?? "none"],
		["lastReceipt", details.lastReceipt ?? "none"],
	];
	return fields
		.filter((field): field is [string, string, ThemeColor?] => field[1] !== undefined)
		.map(
			([key, value, color]) => `${theme.fg("dim", key.padEnd(KEY_WIDTH))}${color ? theme.fg(color, value) : value}`,
		);
}

function renderStatus(
	path: string,
	details: ClmStatusReadDetails,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return framedCard(options, theme, (width, expanded) => {
		const fields = statusFields(details, theme);
		const shown = expanded ? fields : fields.slice(0, STATUS_COLLAPSED_FIELDS);
		return {
			title: `Read ${path}`,
			meta: [],
			sections: [
				{
					lines: [
						...statusGauge(details, width, theme),
						...fit(shown, width),
						...moreLine(fields.length - shown.length, "field", expanded, theme),
					],
				},
			],
		};
	});
}

function signedDelta(before: number, after: number): string {
	const delta = after - before;
	return delta === 0 ? "±0" : `${delta > 0 ? "+" : "−"}${formatNumber(Math.abs(delta))}`;
}

function renderHistory(
	path: string,
	details: ClmHistoryReadDetails,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	// Newest first: the revision a restore or diff most likely targets.
	const revisions = [...details.revisions].reverse();
	return framedCard(options, theme, (width, expanded) => {
		const { shown, hidden } = capped(revisions, expanded);
		const idWidth = Math.min(24, Math.max(8, ...shown.map(entry => entry.revision.length)));
		const causeWidth = Math.max(5, ...shown.map(entry => entry.cause.length));
		const rows = shown.map(entry =>
			[
				theme.fg("accent", truncateToWidth(entry.revision, idWidth, Ellipsis.Unicode).padEnd(idWidth)),
				theme.fg("muted", entry.cause.padEnd(causeWidth)),
				theme.fg("dim", clock(Date.parse(entry.timestamp))),
				`${theme.fg("muted", `${formatNumber(entry.tokensBefore)} → ${formatNumber(entry.tokensAfter)}`)} ${theme.fg(
					entry.tokensAfter <= entry.tokensBefore ? "success" : "warning",
					signedDelta(entry.tokensBefore, entry.tokensAfter),
				)}`,
			].join("  "),
		);
		return {
			title: `Read ${path}`,
			meta: [`${revisions.length} ${revisions.length === 1 ? "revision" : "revisions"}`],
			sections: [
				{
					lines:
						rows.length > 0
							? [...fit(rows, width), ...moreLine(hidden, "revision", expanded, theme)]
							: [theme.fg("dim", "No CLM revisions on this branch yet")],
				},
			],
		};
	});
}

function textBody(
	title: string,
	meta: readonly string[],
	content: string,
	display: ClmReadDisplay | undefined,
	language: string | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const metaText = meta.length > 0 ? ` ${theme.fg("dim", meta.join(theme.sep.dot))}` : "";
	return markFramedBlockComponent(
		createCachedComponent(
			() => Boolean(options.expanded),
			(width, expanded) =>
				renderCodeCell(
					{
						code: display?.text ?? content,
						language,
						title: `${title}${metaText}`,
						status: "complete",
						expanded,
						codeStartLine: display?.startLine,
						codeLineNumbers: display?.lineNumbers,
						width,
					},
					theme,
				),
		),
	);
}

function archiveRow(row: ClmArchiveRow, width: number, theme: Theme): string {
	const markers = [
		row.inContext && theme.fg("dim", "in-context"),
		row.supersededBy && theme.fg("warning", "superseded"),
		row.failed && theme.fg("error", "failed"),
		row.truncated && theme.fg("warning", "truncated"),
	].filter(Boolean);
	const line = [
		theme.fg("accent", row.id),
		theme.fg("dim", `${clock(row.timestamp)} t${row.turn}`),
		theme.fg("muted", itemKind(row).padEnd(10)),
		theme.fg("muted", formatNumber(row.tokens).padStart(6)),
		...markers,
		theme.fg("dim", replaceTabs(row.label)),
	].join("  ");
	return truncateToWidth(line, width, Ellipsis.Unicode);
}

function renderArchiveList(
	path: string,
	details: ClmArchiveListReadDetails,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return framedCard(options, theme, (width, expanded) => {
		const { shown, hidden } = capped(details.items, expanded);
		const range =
			details.items.length === 0
				? "no items"
				: `items ${details.offset + 1}–${details.offset + details.items.length} of ${details.total}`;
		return {
			title: `Read ${path}`,
			meta: [],
			sections: [
				{
					lines: [
						...fit(
							[
								theme.fg(
									"dim",
									`${details.total} items · ${details.inContext} in context · ${details.superseded} superseded · ~${formatNumber(details.tokens)} tok · ${range}`,
								),
							],
							width,
						),
						...shown.map(row => archiveRow(row, width, theme)),
						...moreLine(hidden, "item", expanded, theme),
					],
				},
			],
		};
	});
}

/** The relevance bar and probability when judged, else `#3` (lexical rank); padded to the column's `width`. */
function hitLead(hit: ClmSearchHitRow, width: number, theme: Theme): string {
	if (hit.p !== undefined)
		return `${scoreGauge(hit.p, theme, RELEVANCE_CELLS)} ${theme.fg(scoreColor(hit.p), hit.p.toFixed(2))}`;
	const rank = hit.lexicalRank === undefined ? "" : `#${hit.lexicalRank}`;
	return theme.fg("muted", rank.padEnd(width));
}

function hitOrigin(hit: ClmSearchHitRow, mode: ClmArchiveSearchReadDetails["mode"]): string | undefined {
	if (mode === "regex") return undefined;
	if (mode === "jev" && hit.lexicalRank !== undefined) return `lexical #${hit.lexicalRank}`;
	if (hit.origin === "scan") return "label scan";
	if (hit.origin === "superseder") return "supersedes a match";
	return undefined;
}

function hitRow(
	hit: ClmSearchHitRow,
	mode: ClmArchiveSearchReadDetails["mode"],
	leadWidth: number,
	expanded: boolean,
	theme: Theme,
): string {
	const who = `${itemKind(hit)} t${hit.turn} ${formatNumber(hit.tokens)}`;
	const origin = hitOrigin(hit, mode);
	return [
		...(leadWidth > 0 ? [hitLead(hit, leadWidth, theme)] : []),
		theme.fg("accent", hit.id),
		theme.fg("muted", who.padEnd(16)),
		...(origin ? [theme.fg("dim", origin)] : []),
		...(hit.supersededBy ? [theme.fg("warning", "superseded")] : []),
		...(expanded ? [] : [theme.fg("dim", replaceTabs(hit.preview))]),
	].join("  ");
}

/** Footer facts in plain text; `lexical` carries the fallback reason when ranking stayed lexical. */
function searchFooter(details: ClmArchiveSearchReadDetails): { label: string; lexical?: string; facts: string } {
	if (details.mode === "regex")
		return {
			label: "Regex",
			facts: `/${details.query}/i · ${details.matches} matching of ${details.total} · newest first · exact filter, no rerank`,
		};
	let facts = `BM25 ${details.shortlist} of ${details.matches} (of ${details.total})`;
	if (details.superseders > 0) facts += ` + ${details.superseders} superseding`;
	if (details.scanTotal !== undefined) {
		const scanned = details.scanned ?? 0;
		facts += ` + scan ${scanned}${scanned < details.scanTotal ? ` of ${details.scanTotal}` : ""}`;
	}
	if (details.mode === "jev")
		facts += details.relevant
			? ` → ${details.relevant} at p ≥ ${details.threshold}`
			: ` → none at p ≥ ${details.threshold}; lexical top shown as weak evidence`;
	const judge = details.judge;
	if (judge)
		facts += ` · ${judge.requests} req · ${exact(judge.tokens)} tok · $${judge.costUsd.toFixed(4)} · ${formatDuration(judge.ms)}`;
	if (details.mode === "lexical") return { label: "Lexical", lexical: details.fallbackReason ?? "no rerank", facts };
	return { label: "Jev rerank", facts };
}

function renderSearch(details: ClmArchiveSearchReadDetails, options: RenderResultOptions, theme: Theme): Component {
	const meta = [`${details.hits.length} ${details.hits.length === 1 ? "hit" : "hits"}`];
	if (details.mode === "jev" && details.judge) meta.push(`Jev ${formatDuration(details.judge.ms)}`);
	if (details.mode !== "jev") meta.push(details.mode);
	return framedCard(options, theme, (width, expanded) => {
		const { shown, hidden } = capped(details.hits, expanded);
		const rows: string[] = [];
		// Regex hits carry no rank; judged hits lead with bar + probability; lexical ones with `#n` only.
		const leadWidth =
			details.mode === "regex"
				? 0
				: details.hits.some(hit => hit.p !== undefined)
					? RELEVANCE_CELLS + 5
					: Math.max(2, ...details.hits.map(hit => `#${hit.lexicalRank ?? ""}`.length));
		const indent = " ".repeat(leadWidth > 0 ? leadWidth + 2 : 0);
		for (const hit of shown) {
			rows.push(truncateToWidth(hitRow(hit, details.mode, leadWidth, expanded, theme), width, Ellipsis.Unicode));
			if (expanded && hit.preview) {
				const at = hit.line === undefined ? "" : `L${hit.line}: `;
				const wrapped = wrapTextWithAnsi(`${at}${replaceTabs(hit.preview)}`, Math.max(10, width - indent.length));
				for (const line of wrapped) rows.push(theme.fg("dim", `${indent}${line}`));
			}
		}
		const empty = details.hits.length === 0 ? [theme.fg("dim", `No matching items among ${details.total}`)] : [];
		const footer = searchFooter(details);
		const footerLines = [theme.fg("dim", footer.facts)];
		if (footer.lexical !== undefined)
			footerLines.unshift(`${theme.fg("warning", "lexical order only")} ${theme.fg("dim", `· ${footer.lexical}`)}`);
		return {
			title: `Recall ${details.mode === "regex" ? `/${details.query}/i` : `"${details.query}"`}`,
			meta,
			sections: [
				{ lines: [...empty, ...rows, ...moreLine(hidden, "hit", expanded, theme)] },
				{ label: theme.fg("toolTitle", footer.label), lines: footerLines },
			],
		};
	});
}

/** Render a `read context://…` result from its structured details. */
export function renderClmRead(
	path: string,
	content: string,
	details: ClmReadDetails,
	display: ClmReadDisplay | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	switch (details.kind) {
		case "document":
		case "revision":
			return renderDocument(path, details, display, options, theme);
		case "status":
			return renderStatus(path, details, options, theme);
		case "history":
			return renderHistory(path, details, options, theme);
		case "diff":
			// Full ids head the diff body (`---`/`+++`); the header keeps them short so the title survives.
			return textBody(
				`Read ${path}`,
				[
					`${truncateToWidth(details.before, 18, Ellipsis.Unicode)} → ${truncateToWidth(details.after, 18, Ellipsis.Unicode)}`,
				],
				content,
				display,
				"diff",
				options,
				theme,
			);
		case "archive":
			return renderArchiveList(path, details, options, theme);
		case "archive-item": {
			// The display may carry context lines around the requested range; the path's selector is what was asked for.
			const selector = /\/archive\/[^:/?]+:(.+)$/.exec(path)?.[1];
			return textBody(
				`Recall ${details.item.id}${selector ? `:${selector}` : ""}`,
				[
					`${itemKind(details.item)} t${details.item.turn}`,
					`${formatNumber(details.item.tokens)} tok`,
					...(details.item.supersededBy ? [`superseded by ${details.item.supersededBy}`] : []),
				],
				content,
				display,
				undefined,
				options,
				theme,
			);
		}
		case "archive-search":
			return renderSearch(details, options, theme);
	}
}

// ─────────────────────────────── TSP (native) views ───────────────────────────────

function readHead(path: string, meta: readonly string[]): NativeToolView["tool"] {
	return { title: "Read", target: path, targetKind: "path", meta };
}

function describeBlocks(blocks: readonly ClmBlockRow[]): NativeNode {
	return node("table", {
		cols: [
			{ id: "id", head: "id" },
			{ id: "role", head: "role", priority: 2 },
			{ id: "tokens", head: "tokens", align: "end" },
			{ id: "flags", head: "flags", priority: 1 },
			{ id: "preview", head: "preview", grow: 1, truncate: "end" },
		],
		rows: blocks.map(block => ({
			id: block.id,
			cells: {
				id: [span(block.id, "accent")],
				role: [span(block.role, "muted")],
				tokens: [span(formatNumber(block.tokens), "muted")],
				flags: block.protected ? [span(blockFlags(block), "warning")] : [span(blockFlags(block), "dim")],
				preview: [span(block.preview, "dim")],
			},
		})),
	});
}

function describeArchiveRows(rows: readonly ClmArchiveRow[]): NativeNode {
	return node("table", {
		cols: [
			{ id: "id", head: "id" },
			{ id: "when", head: "when", priority: 1 },
			{ id: "kind", head: "kind" },
			{ id: "tokens", head: "tokens", align: "end" },
			{ id: "label", head: "label", grow: 1, truncate: "end" },
		],
		rows: rows.map(row => ({
			id: row.id,
			cells: {
				id: [span(row.id, "accent")],
				when: [span(`${clock(row.timestamp)} t${row.turn}`, "dim")],
				kind: [span(itemKind(row), "muted")],
				tokens: [span(formatNumber(row.tokens), "muted")],
				label: [span(row.label, row.supersededBy ? "warning" : "dim")],
			},
		})),
	});
}

function describeHit(hit: ClmSearchHitRow, mode: ClmArchiveSearchReadDetails["mode"]): NativeNode {
	const origin = hitOrigin(hit, mode);
	const spans: TspSpan[] = [
		span(hit.id, "accent"),
		span(`  ${itemKind(hit)} t${hit.turn} · ${formatNumber(hit.tokens)}`, "muted"),
		...(origin ? [span(` · ${origin}`, "dim")] : []),
		...(hit.supersededBy ? [span(" · superseded", "warning")] : []),
	];
	const lead =
		hit.p !== undefined
			? node("progress", {
					value: hit.p,
					tone: scoreTone(hit.p),
					title: `relevance ${hit.p.toFixed(2)}`,
					max: { w: 40 },
				})
			: hit.lexicalRank !== undefined && text([span(`#${hit.lexicalRank}`, "muted")]);
	return keyed(
		col(
			compact<NativeChild>([
				row(
					compact<NativeChild>([
						lead,
						hit.p !== undefined && text([span(hit.p.toFixed(2), scoreTone(hit.p))]),
						text(spans),
					]),
					{
						gap: "sm",
					},
				),
				hit.preview !== "" &&
					text([span(`${hit.line === undefined ? "" : `L${hit.line}: `}${hit.preview}`, "dim")], { lines: 1 }),
			]),
			{ gap: "xs", role: "omp.tool.recall.hit" },
		),
		hit.id,
	);
}

/** TSP view of a `read context://…` result. */
export function describeClmRead(
	path: string,
	content: string,
	details: ClmReadDetails,
	display: ClmReadDisplay | undefined,
): NativeToolView {
	switch (details.kind) {
		case "document":
		case "revision": {
			const page = partialRange(display, (details.blockCount ?? details.blocks.length) + 2);
			const blocks = pageBlocks(details, display);
			return {
				tool: readHead(path, [
					String(details.blockCount ?? details.blocks.length) + " blocks",
					formatNumber(details.tokens) + " tok",
				]),
				body: compact<NativeChild>([
					statsText(documentSummary(details, page, blocks.length)),
					describeBlocks(blocks),
				]),
				preview: { lines: COLLAPSED_ROWS + 2 },
			};
		}
		case "status": {
			const scale = details.capacityTokens || details.contextWindow || 0;
			const soft = details.softLimitTokens;
			return {
				tool: readHead(path, [`${formatNumber(details.estimatedRequestTokens)} tok`]),
				body: compact<NativeChild>([
					scale > 0 &&
						node("meter", {
							value: Math.min(1, details.estimatedRequestTokens / scale),
							marks: soft
								? [{ at: soft / scale, icon: "context.compaction", title: `soft limit ${formatNumber(soft)}` }]
								: undefined,
							thresholds: soft ? { warn: soft / scale, bad: 1 } : undefined,
							label: formatNumber(details.estimatedRequestTokens),
							total: formatNumber(scale),
						}),
					kv([
						["estimatedRequestTokens", exact(details.estimatedRequestTokens)],
						["softLimitTokens", soft === undefined ? undefined : exact(soft)],
						["capacityTokens", details.capacityTokens === undefined ? undefined : exact(details.capacityTokens)],
						[
							"remainingTokens",
							details.remainingTokens === undefined ? undefined : exact(details.remainingTokens),
						],
						["revision", details.revision],
						["staged", details.staged ?? "none"],
						["lastReceipt", details.lastReceipt ?? undefined],
					]),
				]),
			};
		}
		case "history":
			return {
				tool: readHead(path, [`${details.revisions.length} revisions`]),
				body: [
					node("table", {
						cols: [
							{ id: "revision", head: "revision", truncate: "middle" },
							{ id: "cause", head: "cause" },
							{ id: "when", head: "when", priority: 1 },
							{ id: "tokens", head: "tokens", align: "end" },
						],
						rows: [...details.revisions].reverse().map(entry => ({
							id: entry.revision,
							cells: {
								revision: [span(entry.revision, "accent")],
								cause: [span(entry.cause, "muted")],
								when: [span(clock(Date.parse(entry.timestamp)), "dim")],
								tokens: [
									span(`${formatNumber(entry.tokensBefore)} → ${formatNumber(entry.tokensAfter)} `, "muted"),
									span(
										signedDelta(entry.tokensBefore, entry.tokensAfter),
										entry.tokensAfter <= entry.tokensBefore ? "success" : "warning",
									),
								],
							},
						})),
					}),
				],
				preview: { lines: COLLAPSED_ROWS + 1 },
			};
		case "diff":
			return {
				tool: readHead(path, [`${details.before} → ${details.after}`]),
				body: [code(display?.text ?? content, { lang: "diff" })],
				preview: { lines: PREVIEW_LIMITS.EXPANDED_LINES },
			};
		case "archive":
			return {
				tool: readHead(path, [`${details.total} items`, `${details.inContext} in context`]),
				body: [describeArchiveRows(details.items)],
				preview: { lines: COLLAPSED_ROWS + 1 },
			};
		case "archive-item":
			return {
				tool: {
					title: "Recall",
					target: details.item.id,
					targetKind: "text",
					meta: [
						`${itemKind(details.item)} t${details.item.turn}`,
						`${formatNumber(details.item.tokens)} tok`,
						...(details.item.supersededBy ? [`superseded by ${details.item.supersededBy}`] : []),
					],
				},
				body: [
					code(display?.text ?? content, {
						start: display?.startLine ?? 1,
						numbers: true,
					}),
				],
				preview: { lines: PREVIEW_LIMITS.EXPANDED_LINES },
			};
		case "archive-search": {
			const footer = searchFooter(details);
			return {
				tool: {
					title: "Recall",
					target: details.query,
					targetKind: "query",
					meta: [`${details.hits.length} hits`, ...(details.mode === "jev" ? [] : [details.mode])],
				},
				body: compact<NativeChild>([
					...details.hits.map(hit => describeHit(hit, details.mode)),
					statsText(
						compact([footer.lexical !== undefined && `lexical order only · ${footer.lexical}`, footer.facts]),
					),
				]),
				preview: { lines: PREVIEW_LIMITS.EXPANDED_LINES },
			};
		}
	}
}
