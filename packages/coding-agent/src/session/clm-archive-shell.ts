/**
 * Conservative detection of files a shell command rewrote, so the CLM archive can mark earlier
 * views of those files superseded. Recognized: `sed -i`/`perl -i`, `tee [-a]`, output
 * redirections (`>`, `>>`, `>|`, `&>`), `mv`/`cp` destinations, `git checkout|restore` paths,
 * and `git apply`/`patch` with an inline (heredoc) patch. Anything the small scanner cannot
 * resolve literally — expansions, globs, command substitution, unknown working directories —
 * yields no path rather than a guess.
 */
import * as path from "node:path";
import { extractFlatShellCommandSegments, readShellWord } from "../tools/shell-tokenize";

interface Word {
	value: string;
	/** No unquoted expansion, glob, or tilde: `value` is exactly what the shell passes. */
	literal: boolean;
}

interface Command {
	argv: Word[];
	/** Output redirection targets (`>`, `>>`, `>|`, `&>`). */
	writes: Word[];
	/** A patch body is usable only with one unambiguous stdin redirect. */
	stdinInputs: number;
}

const ASSIGNMENT_RE = /^[A-Za-z_]\w*=/;
const EXPANSION_CHARS: Record<string, true> = { $: true, "`": true, "*": true, "?": true, "[": true, "{": true };
/** Prefixes that run the next word as the command. */
const WRAPPERS: Record<string, true> = { sudo: true, command: true, env: true, nohup: true, time: true, nice: true };
const DIFF_HEADER_RE = /^--- ([^\t\n]+)[^\n]*\n\+\+\+ ([^\t\n]+)/gm;
const GIT_APPLY_FLAGS: Record<string, true> = { "--index": true, "--reverse": true, "-R": true };
const PATCH_FLAGS: Record<string, true> = {
	"-R": true,
	"--reverse": true,
	"-f": true,
	"--force": true,
	"-s": true,
	"--silent": true,
};

interface HeredocBody {
	offset: number;
	text: string;
}

/** Strip only real heredocs, retaining their command offsets so patches cannot leak between commands. */
function splitHeredocs(command: string): { command: string; bodies: HeredocBody[] } | undefined {
	const lines = command.split("\n");
	const kept: string[] = [];
	const bodies: HeredocBody[] = [];
	let offset = 0;
	let quote: "'" | '"' | undefined;
	for (let line = 0; line < lines.length; line++) {
		const text = lines[line];
		const parts: string[] = [];
		const opened: Array<{ delimiter: string; tabs: boolean; offset: number }> = [];
		let start = 0;
		let length = 0;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (ch === "\\" && quote !== "'") {
				i++;
				continue;
			}
			if (quote) {
				if (ch === quote) quote = undefined;
				continue;
			}
			if (ch === "'" || ch === '"') {
				quote = ch;
				continue;
			}
			if (ch === "#" && (i === 0 || /[ \t;&|]/.test(text[i - 1]))) break;
			if (ch !== "<" || text[i + 1] !== "<") continue;
			if (text[i + 2] === "<") return undefined; // Here-strings remain outside the flat grammar.
			let end = i + 2;
			const tabs = text[end] === "-";
			if (tabs) end++;
			while (text[end] === " " || text[end] === "\t") end++;
			const wordStart = end;
			let delimiterQuote: "'" | '"' | undefined;
			for (; end < text.length; end++) {
				const c = text[end];
				if (c === "\\" && delimiterQuote !== "'") {
					end++;
					continue;
				}
				if (delimiterQuote) {
					if (c === delimiterQuote) delimiterQuote = undefined;
					continue;
				}
				if (c === "'" || c === '"') {
					delimiterQuote = c;
					continue;
				}
				if (/[ \t;&|<>]/.test(c)) break;
			}
			const word = readShellWord(text.slice(wordStart, end));
			if (!word || word === "unterminated") return undefined;
			const prefix = text.slice(start, i);
			parts.push(prefix, "< /dev/null");
			length += prefix.length;
			opened.push({ delimiter: word.value, tabs, offset: offset + length });
			length += "< /dev/null".length;
			start = end;
			i = end - 1;
		}
		parts.push(text.slice(start));
		const header = parts.join("");
		kept.push(header);
		offset += header.length + 1;
		for (const here of opened) {
			const body: string[] = [];
			let terminated = false;
			while (++line < lines.length) {
				const text = here.tabs ? lines[line].replace(/^\t+/, "") : lines[line];
				if (text === here.delimiter) {
					terminated = true;
					break;
				}
				body.push(text);
			}
			if (!terminated) return undefined;
			bodies.push({ offset: here.offset, text: body.join("\n") });
		}
	}
	return { command: kept.join("\n"), bodies };
}

/** Words and output redirections of one flat segment; undefined when quoting is malformed. */
function parseCommand(text: string): Command | undefined {
	const argv: Word[] = [];
	const writes: Word[] = [];
	let stdinInputs = 0;
	let word: Word | undefined;
	let pending: "write" | "skip" | undefined;
	const flush = () => {
		if (!word) return;
		if (pending === "write") writes.push(word);
		else if (pending !== "skip") argv.push(word);
		pending = undefined;
		word = undefined;
	};
	const append = (value: string, literal = true) => {
		word ??= { value: "", literal: true };
		if (word.value === "" && value === "~") word.literal = false;
		word.value += value;
		word.literal &&= literal;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "'") {
			const end = text.indexOf("'", i + 1);
			if (end < 0) return undefined;
			append(text.slice(i + 1, end));
			i = end;
		} else if (ch === '"') {
			append("");
			for (i++; i < text.length && text[i] !== '"'; i++) {
				if (text[i] === "\\" && '"\\$`'.includes(text[i + 1] ?? "")) append(text[++i]);
				else append(text[i], text[i] !== "$" && text[i] !== "`");
			}
			if (i >= text.length) return undefined;
		} else if (ch === "\\") {
			if (text[i + 1] !== "\n") append(text[i + 1] ?? "");
			i++;
		} else if (ch === " " || ch === "\t" || ch === "\n") {
			flush();
		} else if (ch === ">" || ch === "<" || (ch === "&" && text[i + 1] === ">")) {
			// An adjacent unquoted number denotes the redirected descriptor.
			const descriptor = word?.literal && /^\d+$/.test(word.value) ? word.value : undefined;
			if (ch === "<" && (descriptor === undefined || descriptor === "0")) stdinInputs++;
			if (descriptor !== undefined) word = undefined;
			flush();
			if (ch === "&") i++;
			if (ch === "<") {
				// Input redirection and here-strings: the next word is not an argument.
				while (text[i + 1] === "<") i++;
				pending = "skip";
			} else if (text[i + 1] === "&") {
				// `>&2`, `>&-`: descriptor duplication writes no file.
				i++;
				pending = "skip";
			} else {
				if (text[i + 1] === ">" || text[i + 1] === "|") i++;
				pending = "write";
			}
		} else {
			append(ch, !Object.hasOwn(EXPANSION_CHARS, ch));
		}
	}
	flush();
	return { argv, writes, stdinInputs };
}

/** Positional (non-option) words; everything after `--` is positional. */
function positionals(args: readonly Word[], valued: Record<string, true> = {}): Word[] {
	const out: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const { value } = args[i];
		if (value === "--") return [...out, ...args.slice(i + 1)];
		if (value.startsWith("-") && value !== "-") {
			if (Object.hasOwn(valued, value)) i++;
			continue;
		}
		out.push(args[i]);
	}
	return out;
}

/** Parse options before looking for -i: an attached -e/-f value is never another flag. */
function sedTargets(args: readonly Word[]): Word[] {
	let inPlace = false;
	let scriptFromOption = false;
	let ambiguousSuffix: Word | undefined;
	const operands: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const { value, literal } = args[i];
		if (!literal) return [];
		if (value === "--") {
			operands.push(...args.slice(i + 1));
			break;
		}
		if (value === "--in-place" || value.startsWith("--in-place=")) inPlace = true;
		else if (value === "--expression" || value === "--file") {
			scriptFromOption = true;
			i++;
		} else if (value.startsWith("--expression=") || value.startsWith("--file=")) scriptFromOption = true;
		else if (value.startsWith("--")) return [];
		else if (value.startsWith("-") && value !== "-") {
			for (let flag = 1; flag < value.length; flag++) {
				const ch = value[flag];
				if (ch === "e" || ch === "f") {
					scriptFromOption = true;
					if (flag === value.length - 1) i++;
					break;
				}
				if (ch === "i" || ch === "I") {
					inPlace = true;
					if (flag === value.length - 1) {
						if (args[i + 1]?.value === "") i++;
						else if (args[i + 1] && !args[i + 1].value.startsWith("-")) ambiguousSuffix = args[i + 1];
					}
					break; // Remaining characters are a backup suffix, not options.
				}
				if (!"nErszul".includes(ch)) return [];
			}
		} else operands.push(args[i]);
	}
	if (!inPlace) return [];
	// GNU bare -i has an optional suffix; BSD consumes the next word. Multiple
	// operands without -e/-f cannot disambiguate the script from a backup suffix.
	if (ambiguousSuffix && !scriptFromOption && operands.length > 2) return [];
	return scriptFromOption ? operands.filter(operand => operand !== ambiguousSuffix) : operands.slice(1);
}

/** Parse perl switches up to their value: module/include names and script text are not flags. */
function perlTargets(args: readonly Word[]): Word[] {
	let inPlace = false;
	let scriptFromOption = false;
	const operands: Word[] = [];
	for (let i = 0; i < args.length; i++) {
		const { value, literal } = args[i];
		if (!literal) return [];
		if (value === "--") {
			operands.push(...args.slice(i + 1));
			break;
		}
		if (value.startsWith("-") && value !== "-") {
			for (let flag = 1; flag < value.length; flag++) {
				const ch = value[flag];
				if (ch === "i") {
					inPlace = true;
					break;
				}
				if ("eEIMmF".includes(ch)) {
					if (ch === "e" || ch === "E") scriptFromOption = true;
					if (flag === value.length - 1) i++;
					break;
				}
				if (!"npalwWc0123456789".includes(ch)) return [];
			}
		} else operands.push(args[i]);
	}
	if (!inPlace) return [];
	return scriptFromOption ? operands : operands.slice(1);
}

/** Historical filesystem types are unknown: only -T or nonrecursive cp into an explicit directory is certain. */
function copyTargets(args: readonly Word[], move: boolean): Word[] {
	let fileTarget = false;
	for (const arg of args) {
		const value = arg.value;
		if (!arg.literal) return [];
		if (value === "--no-target-directory" || /^-[^-]*T/.test(value)) fileTarget = true;
		if (value === "--recursive" || /^-[^-]*[rRa]/.test(value)) return [];
		if (value.startsWith("--target-directory") || /^-[^-]*t/.test(value)) return [];
	}
	const operands = positionals(args, { "-S": true, "--suffix": true });
	if (operands.length < 2 || operands.slice(0, -1).some(source => source.value.endsWith("/"))) return [];
	const destination = operands.at(-1)!;
	if (fileTarget) return operands.length === 2 ? [destination] : [];
	if (move || !destination.value.endsWith("/")) return [];
	return operands.slice(0, -1).map(source => ({
		value: path.join(destination.value, path.basename(source.value)),
		literal: destination.literal && source.literal,
	}));
}

/** Paths a unified diff touches (`---`/`+++` header pairs), with `strip` leading components removed (`-pN`). */
function diffPaths(bodies: readonly string[], strip: number, rename = true): Word[] {
	const out: Word[] = [];
	for (const body of bodies) {
		for (const [, before, after] of body.matchAll(DIFF_HEADER_RE)) {
			// patch edits one selected file rather than implementing git rename semantics.
			if (
				!rename &&
				before !== "/dev/null" &&
				after !== "/dev/null" &&
				before.trim().split("/").slice(strip).join("/") !== after.trim().split("/").slice(strip).join("/")
			)
				return [];
			for (const raw of [before, after]) {
				const value = raw.trim();
				if (value === "/dev/null" || value.startsWith('"')) continue;
				const parts = value.split("/").filter(part => part !== "");
				if (parts.length <= strip) continue;
				out.push({ value: parts.slice(strip).join("/"), literal: true });
			}
		}
	}
	return out;
}

/** `-p1` / `-p 1` / `--strip=1`; undefined when absent. */
function stripLevel(args: readonly Word[]): number | undefined {
	for (let i = 0; i < args.length; i++) {
		const match = /^(?:-p|--strip=)(\d*)$/.exec(args[i].value);
		if (!match) continue;
		const level = Number(match[1] || args[i + 1]?.value);
		return Number.isInteger(level) ? level : undefined;
	}
	return undefined;
}

function gitTargets(args: readonly Word[], bodies: readonly string[]): { paths: Word[]; cwd?: Word } {
	let i = 0;
	let cwd: Word | undefined;
	for (; i < args.length && args[i].value.startsWith("-"); i++) {
		if (args[i].value === "-C") {
			const next = args[++i];
			if (!next) return { paths: [] };
			cwd = {
				value: path.isAbsolute(next.value) ? next.value : path.join(cwd?.value ?? ".", next.value),
				literal: next.literal && (path.isAbsolute(next.value) || (cwd?.literal ?? true)),
			};
		} else if (args[i].value === "-c") i++;
		else return { paths: [] };
	}
	const sub = args[i]?.value;
	const rest = args.slice(i + 1);

	if (sub === "checkout") {
		if (rest.some(arg => /^-(?:b|B)|^--orphan(?:=|$)/.test(arg.value))) return { paths: [], cwd };
		const separator = rest.findIndex(arg => arg.value === "--");
		return { paths: separator < 0 ? [] : rest.slice(separator + 1), cwd };
	}
	if (sub === "restore") {
		if (rest.some(arg => arg.value.startsWith("--pathspec-from-file"))) return { paths: [], cwd };
		const staged = rest.some(arg => arg.value === "--staged" || /^-[SWq]*S[SWq]*$/.test(arg.value));
		const worktree = rest.some(arg => arg.value === "--worktree" || /^-[SWq]*W[SWq]*$/.test(arg.value));
		if (staged && !worktree) return { paths: [], cwd };
		return { paths: positionals(rest, { "-s": true, "--source": true }), cwd };
	}
	if (sub === "apply") {
		for (let option = 0; option < rest.length; option++) {
			const { value, literal } = rest[option];
			if (!literal) return { paths: [], cwd };
			if (value === "-p") {
				option++;
				continue;
			}
			if (/^-p\d+$/.test(value) || Object.hasOwn(GIT_APPLY_FLAGS, value)) continue;
			return { paths: [], cwd }; // Includes filters, alternate directories and external patch input.
		}
		return { paths: diffPaths(bodies, stripLevel(rest) ?? 1), cwd };
	}
	return { paths: [], cwd };
}

/** Command-owned paths only: shell redirections always resolve in the shell cwd, not git -C. */
function commandTargets(command: Command, bodies: readonly string[]): { paths: Word[]; cwd?: Word } {
	if (command.stdinInputs !== 1 || bodies.length !== 1) bodies = [];
	const argv = command.argv;
	let index = 0;
	while (
		index < argv.length &&
		(ASSIGNMENT_RE.test(argv[index].value) || Object.hasOwn(WRAPPERS, argv[index].value))
	) {
		index++;
		while (index < argv.length && argv[index].value.startsWith("-")) index++;
	}
	const name = argv[index]?.literal ? path.basename(argv[index].value) : undefined;
	const args = argv.slice(index + 1);
	switch (name) {
		case "sed":
		case "gsed":
			return { paths: sedTargets(args) };
		case "perl":
			return { paths: perlTargets(args) };
		case "tee":
			return { paths: positionals(args) };
		case "mv":
		case "cp":
			return { paths: copyTargets(args, name === "mv") };
		case "git":
			return gitTargets(args, bodies);
		case "patch": {
			for (let option = 0; option < args.length; option++) {
				const { value, literal } = args[option];
				if (!literal) return { paths: [] };
				if (value === "-p") {
					option++;
					continue;
				}
				if (/^(?:-p|--strip=)\d+$/.test(value) || Object.hasOwn(PATCH_FLAGS, value)) continue;
				return { paths: [] }; // Unknown options can select another file, directory, output or dry-run mode.
			}
			const strip = stripLevel(args);
			return { paths: strip === undefined ? [] : diffPaths(bodies, strip, false) };
		}
		default:
			return { paths: [] };
	}
}

/**
 * Absolute paths known to be rewritten. A cd is tracked only inside its successful && chain;
 * pipelines never change the parent cwd. Ambiguous syntax and historical file types are not guessed.
 */
export function shellMutatedPaths(command: string, cwd: string | undefined): string[] {
	const split = splitHeredocs(command);
	if (!split) return [];
	const { command: flat, bodies } = split;
	const segments = extractFlatShellCommandSegments(flat);
	const out = new Set<string>();
	let current = cwd;
	let conditionalCwd = false;
	let cursor = 0;
	let bodyIndex = 0;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		const start = flat.indexOf(segment.text, cursor);
		const between = flat.slice(cursor, start).trim();
		if (conditionalCwd && between !== "&&") current = undefined;
		cursor = start + segment.text.length;
		let operatorStart = cursor;
		while (flat[operatorStart] === " " || flat[operatorStart] === "\t" || flat[operatorStart] === "\n")
			operatorStart++;
		const nextOperator = flat.slice(operatorStart, operatorStart + 2);
		const ownBodies: string[] = [];
		while (bodyIndex < bodies.length && bodies[bodyIndex].offset < cursor) {
			if (bodies[bodyIndex].offset >= start) ownBodies.push(bodies[bodyIndex].text);
			bodyIndex++;
		}
		const parsed = parseCommand(segment.text);
		if (!parsed) continue;
		let commandIndex = 0;
		while (
			commandIndex < parsed.argv.length &&
			(ASSIGNMENT_RE.test(parsed.argv[commandIndex].value) ||
				parsed.argv[commandIndex].value === "command" ||
				parsed.argv[commandIndex].value === "builtin")
		) {
			commandIndex++;
			while (parsed.argv[commandIndex]?.value.startsWith("-")) commandIndex++;
		}
		const name = parsed.argv[commandIndex]?.value;
		if (parsed.argv.some(word => word.value === "[[")) return []; // Compound tests are outside the flat grammar.
		const targets = commandTargets(parsed, ownBodies);
		const base =
			targets.cwd === undefined
				? current
				: targets.cwd.literal && path.isAbsolute(targets.cwd.value)
					? targets.cwd.value
					: targets.cwd.literal && current !== undefined
						? path.resolve(current, targets.cwd.value)
						: undefined;
		for (let list = 0; list < 2; list++) {
			const root = list === 0 ? current : base;
			for (const target of list === 0 ? parsed.writes : targets.paths) {
				const value = target.value;
				if (!target.literal || value === "" || value === "-" || value.includes("://")) continue;
				if (!path.isAbsolute(value) && root === undefined) continue;
				const resolved = path.resolve(root ?? "/", value);
				if (resolved === "/dev" || resolved.startsWith("/dev/")) continue;
				out.add(resolved);
			}
		}
		if (name === "cd" || name === "pushd" || name === "popd") {
			// Both pipeline sides and background commands run outside the parent scope.
			if (
				segment.pipedStdin ||
				segments[index + 1]?.pipedStdin ||
				(nextOperator[0] === "&" && nextOperator !== "&&")
			)
				continue;
			const target = parsed.argv[commandIndex + 1];
			current =
				name === "cd" &&
				parsed.argv.length === commandIndex + 2 &&
				target?.literal &&
				target.value !== "-" &&
				nextOperator === "&&" &&
				current !== undefined
					? path.resolve(current, target.value)
					: undefined;
			conditionalCwd = true;
		}
	}
	return [...out];
}
