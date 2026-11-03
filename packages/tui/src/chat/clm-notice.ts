import { formatNumber, pluralize } from "@oh-my-pi/pi-utils";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { card, span, text } from "../native/describe";
import { Memo } from "../native/memo";
import { type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { getThemeEpoch, theme } from "../theme";
import { Container } from "../tui";

/** Host CLM pressure feedback, as data; `message` is the exact text the model receives. */
export type ClmPressureNotice = { message: string } & (
	| { kind: "pressure"; tokens: number; softLimitTokens: number }
	| { kind: "urgent"; tokens: number; softLimitTokens: number; replyCap?: number }
	| { kind: "spill"; artifacts: number }
);

const MUST_EDIT = "model must edit before other work";

/** The fact the notice states, not the instruction the model got. */
function summarize(notice: ClmPressureNotice): string {
	switch (notice.kind) {
		case "pressure":
			return `clm pressure · ${formatNumber(notice.tokens)} of ${formatNumber(notice.softLimitTokens)} soft limit · model asked to prune`;
		case "urgent": {
			const line =
				notice.tokens > notice.softLimitTokens
					? `clm urgent · ${formatNumber(notice.tokens)} past ${formatNumber(notice.softLimitTokens)} soft limit`
					: `clm urgent · ${formatNumber(notice.tokens)} leaves too little reply room`;
			const cap = notice.replyCap === undefined ? "" : ` · reply capped at ${formatNumber(notice.replyCap)}`;
			return `${line}${cap} · ${MUST_EDIT}`;
		}
		case "spill":
			return `clm spill · ${notice.artifacts} unseen tool ${pluralize("result", notice.artifacts)} moved to artifacts · ${MUST_EDIT}`;
	}
}

/**
 * One status row for a CLM pressure, urgent, or spill notice. Pressure stays dim; urgent and spill
 * take the warning color. Ctrl+O reveals the exact model-facing text below the row.
 */
export class ClmNoticeComponent extends Container {
	readonly #notice: ClmPressureNotice;
	readonly #summary: Text;
	readonly #detail: Text;
	#expanded = false;
	readonly #native = new Memo();

	constructor(notice: ClmPressureNotice) {
		super();
		this.#notice = notice;
		const urgent = notice.kind !== "pressure";
		this.#summary = new Text(summarize(notice), 1, 0).setStyleFn(
			value =>
				`${theme.fg(urgent ? "error" : "warning", theme.status.warning)} ${theme.fg(urgent ? "warning" : "dim", value)}`,
		);
		this.#detail = new Text(notice.message, 1, 0).setStyleFn(value => theme.fg("dim", value));
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#rebuild();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.setExpanded(expanded);
	}

	override describe(): NativeNode {
		return this.#native.get([this.#expanded, getThemeEpoch()], () => {
			const urgent = this.#notice.kind !== "pressure";
			return card(
				{
					role: "omp.clm.notice",
					tone: urgent ? "warning" : "neutral",
					head: [
						span(`${theme.status.warning} `, urgent ? "error" : "warning"),
						span(summarize(this.#notice), urgent ? "warning" : "dim"),
					],
					collapsible: true,
					collapsed: !this.#expanded,
					variant: "bare",
				},
				[text([span(this.#notice.message, "dim")], { wrap: "word" })],
			);
		});
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(this.#summary);
		if (this.#expanded) this.addChild(this.#detail);
	}
}
