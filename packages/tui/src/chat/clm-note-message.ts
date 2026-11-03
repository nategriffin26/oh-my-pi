import { FramedMessageComponent, type FramedMessage } from "../chrome/message-frame";
import { theme } from "../theme";

/** Body lines a note card shows before Ctrl+O. */
const COLLAPSED_NOTE_LINES = 6;

/**
 * A model-authored CLM working-state note, framed like other custom messages and placed at the
 * revision that committed it. Long notes collapse behind Ctrl+O.
 */
export class ClmNoteMessageComponent extends FramedMessageComponent<FramedMessage> {
	constructor(text: string, revision: string) {
		super({
			message: { customType: "clm-note", content: text },
			role: "omp.clm.note",
			icon: () => theme.symbol("tool.edit"),
			detail: `model-authored · ${revision}`,
			collapseAfterLines: COLLAPSED_NOTE_LINES,
		});
	}
}
