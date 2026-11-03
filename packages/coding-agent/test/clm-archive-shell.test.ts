import { describe, expect, it } from "bun:test";
import { shellMutatedPaths } from "../src/session/clm-archive-shell";

const CWD = "/repo";
const mutated = (command: string) => shellMutatedPaths(command, CWD).sort();

describe("shell mutation detection for archive supersession", () => {
	it("detects in-place sed and perl edits but not read-only runs", () => {
		expect(mutated("sed -i '' 's/= 1;/= 2;/' src/a.ts && git diff --stat")).toEqual(["/repo/src/a.ts"]);
		expect(mutated("sed -i.bak -e 's/x/y/' a.ts b.ts")).toEqual(["/repo/a.ts", "/repo/b.ts"]);
		expect(mutated("gsed --in-place 's/x/y/' a.ts")).toEqual(["/repo/a.ts"]);
		expect(mutated("sed -n 's/x/y/p' a.ts")).toEqual([]);
		expect(mutated("perl -pi -e 's/x/y/' a.ts")).toEqual(["/repo/a.ts"]);
		expect(mutated("perl -i.orig -pe 's/x/y/' a.ts")).toEqual(["/repo/a.ts"]);
		expect(mutated("perl -ne 'print if /x/' a.ts")).toEqual([]);
	});

	it("takes redirection and tee targets, never the files read", () => {
		expect(mutated("cat a.ts > b.ts")).toEqual(["/repo/b.ts"]);
		expect(mutated("bun test 2>&1 >> logs/test.log")).toEqual(["/repo/logs/test.log"]);
		expect(mutated("echo done &> out.txt")).toEqual(["/repo/out.txt"]);
		expect(mutated("generate | tee -a one.txt /tmp/two.txt")).toEqual(["/repo/one.txt", "/tmp/two.txt"]);
		expect(mutated("grep foo src/a.ts > /dev/null")).toEqual([]);
		expect(mutated("grep foo src/a.ts 2>/dev/null >&2")).toEqual([]);
		expect(mutated("sort < input.txt")).toEqual([]);
		// Quoted operators and expansions are not literal redirections.
		expect(mutated(`echo ">" b.ts`)).toEqual([]);
		expect(mutated(`echo hi > "$OUT"`)).toEqual([]);
		expect(mutated("echo hi > out-*.txt")).toEqual([]);
	});

	it("ignores heredoc bodies while honoring the opening line's redirection", () => {
		expect(mutated("cat > notes.md <<'EOF'\nline > not-a-file.txt\nEOF\necho ok > done.txt")).toEqual([
			"/repo/done.txt",
			"/repo/notes.md",
		]);
	});

	it("takes mv/cp destinations, per source for a directory destination", () => {
		expect(mutated("mv -T a.ts b.ts")).toEqual(["/repo/b.ts"]);
		expect(mutated("cp -f a.ts b.ts dest/")).toEqual(["/repo/dest/a.ts", "/repo/dest/b.ts"]);
		expect(mutated("cp -t dest a.ts")).toEqual([]);
	});

	it("takes git checkout/restore worktree paths and inline patch paths", () => {
		expect(mutated("git checkout -- a.ts b.ts")).toEqual(["/repo/a.ts", "/repo/b.ts"]);
		expect(mutated("git checkout HEAD~1 -- src/a.ts")).toEqual(["/repo/src/a.ts"]);
		expect(mutated("git checkout main")).toEqual([]);
		expect(mutated("git restore --source HEAD a.ts")).toEqual(["/repo/a.ts"]);
		expect(mutated("git restore --staged a.ts")).toEqual([]);
		expect(mutated("git -C pkg restore a.ts")).toEqual(["/repo/pkg/a.ts"]);
		const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n--- not a header\n-old\n+new";
		expect(mutated(`git apply <<'EOF'\n${patch}\nEOF`)).toEqual(["/repo/src/x.ts"]);
		expect(mutated(`git apply --check <<'EOF'\n${patch}\nEOF`)).toEqual([]);
		expect(mutated(`patch -p1 <<'EOF'\n--- a/new.ts\n+++ /dev/null\nEOF`)).toEqual(["/repo/new.ts"]);
		// The patch file's content is not in the command: no paths.
		expect(mutated("git apply fix.patch")).toEqual([]);
	});

	it("follows literal cd and drops relative paths once the directory is unknown", () => {
		expect(mutated("cd pkg && sed -i 's/x/y/' a.ts")).toEqual(["/repo/pkg/a.ts"]);
		expect(mutated(`cd "$DIR" && sed -i 's/x/y/' a.ts > /tmp/log`)).toEqual(["/tmp/log"]);
		expect(shellMutatedPaths("sed -i 's/x/y/' a.ts > /tmp/log", undefined)).toEqual(["/tmp/log"]);
		expect(mutated("echo x > http://host/file")).toEqual([]);
	});
});
