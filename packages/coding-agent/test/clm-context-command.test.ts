import { describe, expect, test } from "bun:test";
import { parseContextCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/clm-context";

describe("context command parsing", () => {
	test("bare context inspects status rather than restoring history", () => {
		expect(parseContextCommand("")).toEqual({ action: "read", target: { kind: "status" } });
		expect(parseContextCommand("  STATUS \t")).toEqual({ action: "read", target: { kind: "status" } });
	});

	test("show and history select distinct read surfaces", () => {
		expect(parseContextCommand("show")).toEqual({ action: "read", target: { kind: "document" } });
		expect(parseContextCommand("history")).toEqual({ action: "read", target: { kind: "history" } });
	});

	test("preserves revision identity and distinguishes inspection from restore", () => {
		expect(parseContextCommand(" DiFf \tRev-A ")).toEqual({
			action: "read",
			target: { kind: "diff", revision: "Rev-A" },
		});
		expect(parseContextCommand(" RESTORE \tRev-A ")).toEqual({ action: "restore", revision: "Rev-A" });
	});

	test("rejects missing revisions, extra arguments, and unknown actions instead of guessing a write", () => {
		for (const args of ["restore", "diff", "restore A B", "diff A\nB", "status A", "show A", "history A", "undo"]) {
			expect(() => parseContextCommand(args)).toThrow();
		}
	});
});
