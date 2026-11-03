import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildClmArchive } from "../src/session/clm-archive";
import { shellMutatedPaths } from "../src/session/clm-archive-shell";
import { SessionManager } from "../src/session/session-manager";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Real archive chronology, not an assertion against a copied parser. Each file view is
// older than the successful shell result and must only become stale for a known write.
function archiveAfter(command: string, paths: string[]) {
	const manager = SessionManager.inMemory("/repo");
	let timestamp = 1;
	for (const [index, file] of paths.entries()) {
		const call: AssistantMessage = {
			role: "assistant",
			api: "mock",
			provider: "mock",
			model: "archive",
			usage,
			stopReason: "toolUse",
			timestamp: timestamp++,
			content: [{ type: "toolCall", id: `read-${index}`, name: "read", arguments: { path: file } }],
		};
		manager.appendMessage(call);
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: `read-${index}`,
			toolName: "read",
			timestamp: timestamp++,
			content: [{ type: "text", text: `Current view of ${file}` }],
			isError: false,
		};
		manager.appendMessage(result);
	}
	manager.appendMessage({
		role: "assistant",
		api: "mock",
		provider: "mock",
		model: "archive",
		usage,
		stopReason: "toolUse",
		timestamp: timestamp++,
		content: [{ type: "toolCall", id: "shell", name: "bash", arguments: { command } }],
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "shell",
		toolName: "bash",
		timestamp: timestamp++,
		content: [{ type: "text", text: "Completed successfully" }],
		isError: false,
	});
	return buildClmArchive(manager);
}

const regressions: Array<{ name: string; command: string; current: string[]; stale?: string[] }> = [
	{ name: "test comparisons are not redirects", command: "[[ a > b ]]", current: ["b"] },
	{ name: "arithmetic is not a redirect", command: "(( 4 > 2 ))", current: ["2"] },
	{ name: "quoted and escaped operators are data", command: "echo '>' b; echo \\> b", current: ["b"] },
	{
		name: "quoted heredoc spelling leaves later commands intact",
		command: 'echo "<<EOF"\necho x > out',
		current: ["EOF"],
		stale: ["out"],
	},
	{
		name: "escaped heredoc spelling leaves later commands intact",
		command: "echo \\<\\<EOF\necho x > out",
		current: ["EOF"],
		stale: ["out"],
	},
	{
		name: "punctuation in heredoc delimiters is literal",
		command: "cat <<END!\nEND\ntee untouched\nEND!\necho x > out",
		current: ["untouched"],
		stale: ["out"],
	},
	{
		name: "heredocs belong only to their own command",
		command: "cat <<EOF\n--- a/victim\n+++ b/victim\nEOF\ngit apply external.patch",
		current: ["victim"],
	},
	{
		name: "quoted diff paths are not guessed",
		command: "git apply <<'EOF'\n--- a/old\n+++ b/new\nEOF",
		current: ["a/old"],
		stale: ["old", "new"],
	},
	{
		name: "pipeline cd cannot change the parent directory",
		command: "cd pkg | cat; echo x > out",
		current: ["pkg/out"],
		stale: ["out"],
	},
	{
		name: "pipeline consumer cd cannot change parent state",
		command: "echo x | cd pkg; echo x > out",
		current: ["pkg/out"],
		stale: ["out"],
	},
	{
		name: "failed cd alternative does not use its requested directory",
		command: "cd missing || echo x > out",
		current: ["missing/out"],
	},
	{
		name: "unconditional continuation cannot prove cd succeeded",
		command: "cd missing; echo x > out",
		current: ["missing/out"],
	},
	{ name: "subshell state is not guessed", command: "(cd pkg); echo x > out", current: ["pkg/out"] },
	{ name: "sed option arguments cannot enable in-place editing", command: "sed -einline a", current: ["a"] },
	{
		name: "joined sed expression is not a file operand",
		command: "sed -i -es/x/y/ a b",
		current: ["s/x/y/"],
		stale: ["a", "b"],
	},
	{ name: "unknown sed long options cannot imply editing", command: "sed --in-placebo x a", current: ["a"] },
	{ name: "cp without directory spelling cannot identify destination", command: "cp source dest", current: ["dest"] },
	{ name: "mv without directory spelling cannot identify destination", command: "mv source dest", current: ["dest"] },
	{ name: "recursive copies do not rewrite directory views", command: "cp -R source dest/", current: ["dest/source"] },
	{ name: "checkout branch creation is not path checkout", command: "git checkout -b topic -- a", current: ["a"] },
	{ name: "git C options compose", command: "git -C pkg -C sub restore a", current: ["sub/a"], stale: ["pkg/sub/a"] },
	{
		name: "git C cannot relocate shell redirection",
		command: "git -C pkg restore a > log",
		current: ["pkg/log"],
		stale: ["pkg/a", "log"],
	},
	{ name: "descriptor duplication does not create files", command: "echo x 2>&1 >&2", current: ["1", "2"] },
	{
		name: "command substitutions cannot turn dynamic tee args into paths",
		command: "tee $(printf out)",
		current: ["out", "$(printf", "out)"],
	},
	{
		name: "BSD backup suffix cannot become a sed script path",
		command: "sed -i .bak 's/x/y/' a",
		current: ["s/x/y/", ".bak"],
	},
	{ name: "perl module names cannot enable in-place editing", command: "perl -Mstrict -e 'print' a", current: ["a"] },
	{
		name: "restore pathspec input is not a worktree target",
		command: "git restore --pathspec-from-file paths",
		current: ["paths"],
	},
	{
		name: "patch check mode cannot stale a file",
		command: "patch -C -p1 <<EOF\n--- a/victim\n+++ b/victim\nEOF",
		current: ["victim"],
	},
	{
		name: "independent continuation cannot prove a prior cd succeeded",
		command: "cd missing && true; echo x > out",
		current: ["missing/out"],
	},
	{
		name: "cd redirection uses the old directory",
		command: "cd pkg > log && echo x > out",
		current: ["pkg/log"],
		stale: ["log", "pkg/out"],
	},
	{
		name: "compound test operators never leak into shell redirects",
		command: "[[ a > b && c > d ]]",
		current: ["b", "d"],
	},
	{ name: "assignments do not hide a parent-scope cd", command: "X=1 cd pkg && echo x > out", current: ["out"] },
	{
		name: "command builtin does not hide a parent-scope cd",
		command: "command cd pkg && echo x > out",
		current: ["out"],
	},
	{
		name: "later stdin input overrides an inline patch",
		command: "git apply <<EOF < other.patch\n--- a/victim\n+++ b/victim\nEOF",
		current: ["victim"],
	},
	{
		name: "last heredoc alone determines patch input",
		command: "git apply <<EOF <<LAST\n--- a/victim\n+++ b/victim\nEOF\n--- a/other\n+++ b/other\nLAST",
		current: ["victim"],
	},
	{
		name: "apply directory options cannot stale root views",
		command: "git apply --directory=subdir <<EOF\n--- a/victim\n+++ b/victim\nEOF",
		current: ["victim"],
	},
	{
		name: "apply excluded paths are not inferred",
		command: "git apply --exclude=victim <<EOF\n--- a/victim\n+++ b/victim\nEOF",
		current: ["victim"],
	},
	{ name: "combined staged restore flags do not change the worktree", command: "git restore -Sq a", current: ["a"] },
	{
		name: "patch combined check flags do not imply mutation",
		command: "patch -Cp1 <<EOF\n--- a/victim\n+++ b/victim\nEOF",
		current: ["victim"],
	},
	{
		name: "patch reverse cannot guess which rename header names a file",
		command: "patch -R -p1 <<EOF\n--- a/old\n+++ b/new\nEOF",
		current: ["old", "new"],
	},
];

describe("archive-observable shell supersession regressions", () => {
	for (const { name, command, current, stale = [] } of regressions) {
		it(name, () => {
			const archive = archiveAfter(command, [...current, ...stale]);
			const shell = archive.items.find(item => item.label.startsWith("bash "))!;
			for (const file of current) {
				const read = archive.items.find(item => item.label === `read ${file}`)!;
				expect(read.supersededBy).toBeUndefined();
			}
			for (const file of stale) {
				const read = archive.items.find(item => item.label === `read ${file}`)!;
				expect(read.supersededBy).toBe(shell.id);
			}
		});
	}

	it("retains unambiguous file writes and literal cd chains", () => {
		const command = "cd pkg && sed -i 's/x/y/' a && echo x > b && cp -T source dest && tee c";
		const archive = archiveAfter(command, ["pkg/a", "pkg/b", "pkg/dest", "pkg/c", "pkg/source"]);
		const shell = archive.items.find(item => item.label.startsWith("bash "))!;
		for (const file of ["pkg/a", "pkg/b", "pkg/dest", "pkg/c"])
			expect(archive.items.find(item => item.label === `read ${file}`)!.supersededBy).toBe(shell.id);
		expect(archive.items.find(item => item.label === "read pkg/source")!.supersededBy).toBeUndefined();
	});

	it("does not reinterpret a long nonmutating heredoc as shell commands", () => {
		const command = `cat <<'EOF'\n${"echo x > untouched\n".repeat(30_000)}EOF\necho x > written`;
		expect(shellMutatedPaths(command, "/repo")).toEqual(["/repo/written"]);
	});
});
