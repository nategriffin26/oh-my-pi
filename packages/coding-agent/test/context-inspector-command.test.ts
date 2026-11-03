import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Container, Text, TUI } from "@oh-my-pi/pi-tui";
import { ContextInspector } from "@oh-my-pi/pi-tui/overlays/context-inspector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { CommandController } from "../src/modes/controllers/command-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { ClmContext } from "../src/session/clm-context";
import { SessionManager } from "../src/session/session-manager";
import { MemorySessionStorage } from "../src/session/session-storage";

function session(label: string) {
	const manager = SessionManager.create("/inspector", `/inspector/${Bun.randomUUIDv7()}`, new MemorySessionStorage());
	const first: AgentMessage = { role: "user", content: label, timestamp: 1 };
	let messages: AgentMessage[] = [first];
	manager.appendMessage(first);
	let enabled = true;
	const clm = new ClmContext({
		manager,
		enabled: () => enabled,
		epoch: () => "epoch",
		isDisposed: () => false,
		isStreaming: () => false,
		model: () => undefined,
		messages: () => messages,
		estimate: () => 10,
		assertFits: () => {},
		persistTurn: async () => true,
		publish: next => {
			messages = next;
		},
		notice: () => {},
	});
	return {
		getClmContext: () => clm,
		getClmInspector: () => clm,
		sessionManager: manager,
		disable: () => {
			enabled = false;
		},
	};
}

function harness() {
	const main = session("MAIN_CONTEXT");
	const child = session("CHILD_CONTEXT");
	let viewed = main;
	const ui = new TUI(new VirtualTerminal(120, 40));
	const editor = new Text("editor");
	const previous = new Text("previous focus");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.setFocus(previous);
	const ctx = {
		session: main,
		get viewSession() {
			return viewed;
		},
		ui,
		editor,
		editorContainer,
		showError: (message: string) => {
			throw new Error(message);
		},
	} as unknown as InteractiveModeContext;
	const controller = new CommandController(ctx);
	return {
		main,
		child,
		ui,
		previous,
		controller,
		view: (next: typeof main) => {
			viewed = next;
		},
		inspector: () => {
			const view = ui.getFocused();
			if (!(view instanceof ContextInspector)) throw new Error("no inspector");
			return view;
		},
	};
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

describe("context inspector command lifecycle", () => {
	it("inspects the session attached to the transcript rather than the main session", async () => {
		const h = harness();
		h.view(h.child);
		await h.controller.handleContextCommand();
		const frame = h.inspector().render(120).join("\n");
		expect(frame).toContain("CHILD_CONTEXT");
		expect(frame).not.toContain("MAIN_CONTEXT");
	});

	it("restores the previous keyboard target when dismissed", async () => {
		const h = harness();
		await h.controller.handleContextCommand();
		h.inspector().handleInput("\x1b");
		expect(h.ui.hasOverlay()).toBe(false);
		expect(h.ui.getFocused()).toBe(h.previous);
	});

	it("dismisses the old snapshot when CLM is disabled while open", async () => {
		const h = harness();
		await h.controller.handleContextCommand();
		const inspector = h.inspector();
		h.main.disable();
		expect(inspector.render(120)).toEqual([]);
		expect(h.ui.hasOverlay()).toBe(false);
		expect(h.ui.getFocused()).toBe(h.previous);
	});

	it("dismisses the old snapshot on a session switch instead of searching the new archive", async () => {
		const h = harness();
		await h.controller.handleContextCommand();
		const inspector = h.inspector();
		await h.main.sessionManager.newSession();
		inspector.openSearch();
		expect(h.ui.hasOverlay()).toBe(false);
		expect(h.ui.getFocused()).toBe(h.previous);
	});
});
