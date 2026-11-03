import { formatNumber, pluralize } from "@oh-my-pi/pi-utils";
import { Spacer } from "../components/spacer";
import { formatExpandHint, formatMoreItems, formatStatusIcon, replaceTabs } from "../render/render-utils";
import { framedToolCard, type ToolCardSnapshot } from "../render/tool-card";
import { theme } from "../theme";
import { Container } from "../tui";
import { Ellipsis, truncateToWidth } from "../utils";

/** One archive item a committed edit took out of the model's context, or a note it added. */
export interface ClmContextEditRow {
	/** Archive id (`h…`); recallable through `context://self/archive/<id>`. */
	id: string;
	/** Tool name or archive kind. */
	kind: string;
	tokens: number;
	/** One-line preview. */
	label: string;
}

/** The receipt of one CLM write transaction, as the transcript shows it. */
export type ClmContextEditView =
	| {
			state: "staged";
			transactionId: string;
			revision: string;
			snapshotId: string;
			removed: number;
			notes: number;
	  }
	| {
			state: "committed";
			previousRevision: string;
			revision: string;
			tokensBefore: number;
			tokensAfter: number;
			removed: readonly ClmContextEditRow[];
			notes: readonly ClmContextEditRow[];
			/** Archive items now on this branch; removed ones stay recallable there. */
			archiveItems: number;
			/** Newly archived items at this commit; absent on older journals. */
			archiveGrowth?: number;
	  }
	| { state: "rejected"; transactionId: string; reason: string };

/** Removed rows visible before Ctrl+O. */
const COLLAPSED_ROWS = 2;
const KEY_WIDTH = 9;

const grouped = new Intl.NumberFormat("en-US");

function keyValue(key: string, value: string): string {
	return `${theme.fg("dim", key.padEnd(KEY_WIDTH))}${value}`;
}

function signedTokens(before: number, after: number): string {
	const delta = after - before;
	const text = `(${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${grouped.format(Math.abs(delta))})`;
	return theme.fg(delta <= 0 ? "success" : "warning", text);
}

function itemRows(rows: readonly ClmContextEditRow[], sign: "−" | "+", width: number): string[] {
	const idWidth = Math.max(0, ...rows.map(row => row.id.length));
	const kindWidth = Math.min(12, Math.max(4, ...rows.map(row => row.kind.length)));
	return rows.map(row =>
		truncateToWidth(
			[
				theme.fg(sign === "−" ? "error" : "success", sign),
				theme.fg("accent", row.id.padEnd(idWidth)),
				theme.fg("muted", truncateToWidth(row.kind, kindWidth, Ellipsis.Unicode).padEnd(kindWidth)),
				theme.fg("muted", formatNumber(row.tokens).padStart(5)),
				theme.fg("dim", replaceTabs(row.label)),
			].join("  "),
			width,
			Ellipsis.Unicode,
		),
	);
}

/**
 * Tool-style `✎ Context edit` card for one CLM write: pending while staged, then committed
 * (revision, request tokens before → after, removed items, notes, archive growth) or rejected.
 * The removed list collapses behind Ctrl+O.
 */
export class ClmContextEditComponent extends Container {
	#view: ClmContextEditView;
	#expanded = false;

	constructor(view: ClmContextEditView) {
		super();
		this.#view = view;
		this.addChild(new Spacer(1));
		this.addChild(framedToolCard(theme, ({ contentWidth }) => this.#snapshot(contentWidth)));
	}

	get view(): ClmContextEditView {
		return this.#view;
	}

	/** Advance a live card in place (staged → rejected). */
	update(view: ClmContextEditView): void {
		this.#view = view;
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.invalidate();
	}

	/** A staged card still advances to rejected in place; scrollback must not freeze it yet. */
	isTranscriptBlockFinalized(): boolean {
		return this.#view.state !== "staged";
	}

	#snapshot(width: number): ToolCardSnapshot {
		const view = this.#view;
		const icon = (status: "pending" | "success" | "error") =>
			`${theme.fg("accent", theme.symbol("tool.edit"))} ${formatStatusIcon(status, theme)}`;
		switch (view.state) {
			case "staged":
				return {
					phase: "pending",
					status: {
						iconOverride: icon("pending"),
						title: "Context edit",
						titleColor: "toolTitle",
						meta: ["staged", view.transactionId],
					},
					body: [
						keyValue(
							"base",
							// The pre-revision root is `root:<session id>`; the session id adds nothing here.
							`${view.revision.startsWith("root:") ? "root" : view.revision} · snapshot ${view.snapshotId.slice(-8)}`,
						),
						keyValue(
							"draft",
							theme.fg(
								"muted",
								`−${view.removed} ${pluralize("message", view.removed)} · +${view.notes} ${pluralize("note", view.notes)}`,
							),
						),
						theme.fg("dim", "waiting for the turn boundary to validate and publish"),
					].map(line => truncateToWidth(line, width, Ellipsis.Unicode)),
				};
			case "rejected":
				return {
					phase: "error",
					status: {
						iconOverride: icon("error"),
						title: "Context edit",
						titleColor: "toolTitle",
						badge: { label: "rejected", color: "error" },
						meta: [view.transactionId],
					},
					body: [
						keyValue("reason", theme.fg("error", replaceTabs(view.reason))),
						keyValue("result", theme.fg("muted", "nothing applied; the active revision is unchanged")),
					],
				};
			case "committed": {
				const removedTokens = view.removed.reduce((sum, row) => sum + row.tokens, 0);
				const shown = this.#expanded ? view.removed : view.removed.slice(0, COLLAPSED_ROWS);
				const hidden = view.removed.length - shown.length;
				const hint = formatExpandHint(theme, this.#expanded, true);
				const listed = [
					...itemRows(shown, "−", width),
					...(this.#expanded ? itemRows(view.notes, "+", width) : []),
					...(hidden > 0 ? [theme.fg("dim", `${formatMoreItems(hidden, "item")}${hint ? ` ${hint}` : ""}`)] : []),
				];
				return {
					phase: "success",
					status: {
						iconOverride: icon("success"),
						title: "Context edit",
						titleColor: "toolTitle",
						meta: [`${view.previousRevision}→${view.revision}`],
					},
					body: [
						keyValue(
							"tokens",
							`${grouped.format(view.tokensBefore)} → ${grouped.format(view.tokensAfter)} ${signedTokens(view.tokensBefore, view.tokensAfter)}`,
						),
						keyValue(
							"context",
							`−${view.removed.length} ${pluralize("item", view.removed.length)} (${formatNumber(removedTokens)} tok) · +${view.notes.length} ${pluralize("note", view.notes.length)}`,
						),
						keyValue(
							"archive",
							theme.fg(
								"muted",
								`${view.archiveGrowth === undefined ? "" : `+${view.archiveGrowth} archived · `}${view.archiveItems} ${pluralize("item", view.archiveItems)} via context://self/archive`,
							),
						),
					].map(line => truncateToWidth(line, width, Ellipsis.Unicode)),
					sections: listed.length > 0 ? [{ label: "Removed", content: listed }] : undefined,
				};
			}
		}
	}
}
