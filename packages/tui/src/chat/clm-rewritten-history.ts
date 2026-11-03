import { formatNumber } from "@oh-my-pi/pi-utils";
import { isToolActivityComponent, type ToolActivityComponent } from "../chrome/tool-activity";
import { node, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { getThemeEpoch, theme } from "../theme";
import { type Component, Container } from "../tui";
import { Ellipsis, truncateToWidth, visibleWidth } from "../utils";

/** What one run of scrollback lost: the revision that removed it and where to recall it. */
export interface ClmRewrittenHistoryHeader {
	/** Revision that took this run out of the model's context. */
	revision: string;
	/** Archive ids (`h…`) the run's content is recallable under. */
	ids: readonly string[];
	/** Archive token size of those items. */
	tokens: number;
}

/** Gutter plus one space. */
const GUTTER_WIDTH = 2;

/**
 * Transcript blocks a committed CLM revision removed from the model's context: still readable,
 * rendered dim behind a gutter, under one header naming the revision, the size, and the archive
 * ids that recall them. The wrapped blocks stay intact (expansion, tool-activity visibility and
 * pending results keep routing to them); only their presentation changes.
 */
export class ClmRewrittenHistoryComponent extends Container implements ToolActivityComponent {
	#header: ClmRewrittenHistoryHeader;
	#open = true;
	#toolActivityVisible = true;
	#memo: { key: string; parts: readonly (readonly string[])[]; lines: readonly string[] } | undefined;

	constructor(header: ClmRewrittenHistoryHeader) {
		super();
		this.#header = header;
	}

	setHeader(header: ClmRewrittenHistoryHeader): void {
		this.#header = header;
		this.#memo = undefined;
	}

	/** Move a block into the run. */
	adopt(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		this.addChild(component);
		this.#memo = undefined;
	}

	/** The run is complete; it finalizes once every wrapped block has. */
	close(): void {
		this.#open = false;
	}

	isTranscriptBlockFinalized(): boolean {
		return (
			!this.#open &&
			this.children.every(
				child =>
					(child as Component & { isTranscriptBlockFinalized?(): boolean }).isTranscriptBlockFinalized?.() ?? true,
			)
		);
	}

	setExpanded(expanded: boolean): void {
		for (const child of this.children) {
			const expandable = child as Partial<{ setExpanded(expanded: boolean): void }>;
			if (typeof expandable.setExpanded === "function") expandable.setExpanded(expanded);
		}
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
	}

	override invalidate(): void {
		this.#memo = undefined;
		super.invalidate();
	}

	override render(width: number): readonly string[] {
		const inner = Math.max(1, width - GUTTER_WIDTH);
		const parts = this.children.map(child => child.render(inner));
		const key = `${width}:${getThemeEpoch()}`;
		const memo = this.#memo;
		if (memo?.key === key && memo.parts.length === parts.length && memo.parts.every((part, i) => part === parts[i])) {
			return memo.lines;
		}
		const gutter = theme.fg("dim", `${theme.symbol("clm.gutter")} `);
		const header = this.#headerParts(width);
		const lines = [
			"",
			truncateToWidth(
				`${theme.fg("dim", header.lead)}${header.recall ? theme.fg("muted", header.recall) : ""}`,
				width,
				Ellipsis.Unicode,
			),
		];
		for (const part of parts) {
			let start = 0;
			let end = part.length;
			const plain = part.map(line => Bun.stripANSI(line));
			while (start < end && !/\S/.test(plain[start])) start++;
			while (end > start && !/\S/.test(plain[end - 1])) end--;
			for (let index = start; index < end; index++) lines.push(`${gutter}${theme.fg("dim", plain[index])}`);
		}
		this.#memo = { key, parts, lines };
		return lines;
	}

	override describe(): NativeNode {
		const header = this.#headerParts(Number.POSITIVE_INFINITY);
		return node(
			"section",
			{ head: [span(header.lead, "dim"), ...(header.recall ? [span(header.recall, "muted")] : [])] },
			this.children,
		);
	}

	/** `lead` names revision and size; `recall` lists the archive ids that fit `width`, then `+N`. */
	#headerParts(width: number): { lead: string; recall: string } {
		const { revision, ids, tokens } = this.#header;
		const lead = `${theme.symbol("clm.gutter")} out of model context · ${revision} · −${formatNumber(tokens)}`;
		if (ids.length === 0) return { lead, recall: "" };
		let shown = 0;
		let used = visibleWidth(lead) + " · recall".length;
		for (const id of ids) {
			const remaining = ids.length - shown - 1;
			const suffix = remaining > 0 ? ` +${remaining}` : "";
			if (shown > 0 && used + 1 + id.length + suffix.length > width) break;
			used += 1 + id.length;
			shown++;
		}
		const more = ids.length - shown;
		return { lead, recall: ` · recall ${ids.slice(0, shown).join(" ")}${more > 0 ? ` +${more}` : ""}` };
	}
}

/**
 * Transcript blocks with out-of-context runs unwrapped, for display toggles that address blocks
 * by type (thinking visibility, images, tool expansion).
 */
export function* transcriptBlocks(children: readonly Component[]): Generator<Component> {
	for (const child of children) {
		if (child instanceof ClmRewrittenHistoryComponent) yield* child.children;
		else yield child;
	}
}
