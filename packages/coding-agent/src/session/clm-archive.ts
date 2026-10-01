/**
 * Verbatim, deduplicated archive of everything that entered a CLM session's context.
 *
 * The journal is append-only: CLM edits publish `context_projection` snapshots but never
 * remove the original `message` entries, so content the model deleted from its context is
 * still recoverable. The archive rebuilds sub-exchange items from that journal — one
 * user/assistant-text message, or one tool call paired with its result — and names each
 * item by a content hash, so the same content keeps the same id across revisions, resumes,
 * and processes. Model-authored notes exist only inside projections and are archived from
 * there. Scope is the active branch after its last `reset_boundary`: a reset is the user
 * discarding prior history, matching `context://self/history`.
 */
import * as path from "node:path";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { editInspect } from "@oh-my-pi/pi-natives";
import { customMessageEntryMessage } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
} from "@oh-my-pi/pi-agent-core/compaction/messages";
import { shellMutatedPaths } from "./clm-archive-shell";
import {
	CLM_FEEDBACK_MESSAGE_TYPE,
	CLM_HANDOFF_MESSAGE_TYPE,
	CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE,
	CLM_PARENT_MANIFEST_MESSAGE_TYPE,
	getContextProjectionMessages,
} from "./clm-state";
import { bashExecutionToText, pythonExecutionToText } from "./messages";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";
import { CLM_ARCHIVE_TEXT_FIELDS, isPersistenceTruncatedString, persistenceTruncationKey } from "./session-persistence";
import { sessionMessagePersistenceKey } from "./turn-persistence";

export type ClmArchiveKind = "user" | "assistant" | "tool" | "note" | "custom" | "subagent" | "summary";

export interface ClmArchiveItem {
	/** `h` + 10 hex chars hashed from normalized content; equal content always shares one id. */
	readonly id: string;
	readonly kind: ClmArchiveKind;
	/** Underlying message role, or the custom message type. */
	readonly role: string;
	readonly toolName?: string;
	/** One line: tool + path/command, or the first text line; at most ~120 chars. */
	readonly label: string;
	/**
	 * Verbatim model-readable rendering; a tool item is `name(args)` plus its `[toolResult]`, with
	 * multi-line string args as `field: <<EOF` blocks after the call line.
	 */
	readonly text: string;
	readonly tokens: number;
	/** First occurrence (epoch ms). */
	readonly timestamp: number;
	/** Latest occurrence (epoch ms). */
	readonly lastSeen: number;
	/** Distinct journal occurrences of this exact content. */
	readonly occurrences: number;
	/** Ordinal of the user turn the first occurrence belongs to; 0 before the first user message. */
	readonly turn: number;
	/** Present in the current effective context. */
	readonly inContext: boolean;
	/**
	 * A later write/edit or shell rewrite (`sed -i`, `>`, `tee`, `mv`/`cp`, `git checkout`/
	 * `restore`/`apply`, `patch`) that replaces every touched path. Partial or split replacements
	 * remain unmarked because this item can still hold current evidence for another path. A later
	 * successful rerun of the same normalized shell command in the same directory, or a later read
	 * of the same path and range with different content, also supersedes.
	 */
	readonly supersededBy?: string;
	/** Only a persistence-truncated copy survives (strings over the journal's per-string cap). */
	readonly truncated?: boolean;
	/** The call failed: an error result, a non-zero exit, or a cancelled run. */
	readonly failed?: boolean;
}

export interface ClmArchive {
	/** Chronological, deduplicated. */
	readonly items: readonly ClmArchiveItem[];
	get(id: string): ClmArchiveItem | undefined;
	/** Archive ids of the items these effective messages (e.g. one CLM block's) render to, in order. */
	idsFor(messages: readonly AgentMessage[]): string[];
}

export interface ClmArchiveOptions {
	/** Current effective context; defaults to the context rebuilt from the journal. */
	live?: readonly AgentMessage[];
	/** Token estimator; pass the session's CLM tokenizer so sizes match `context://self/status`. */
	tokenizer?: Tokenizer;
}

export const CLM_ARCHIVE_ID_PATTERN = /^h[0-9a-f]{10}$/;
const LABEL_MAX = 120;
/** Argument names that identify what a tool call acted on, in preference order. */
const LABEL_ARGS = ["path", "command", "pattern", "query", "url", "file", "code", "input"] as const;
const PATCH_HEADER_RE = /^\[([^\]\n#]+)#[0-9A-Fa-f]{4}\]/gm;
const READ_SELECTOR_RE = /(?::(?:raw|conflicts|img|-?\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*))+$/;

interface Unit {
	kind: ClmArchiveKind;
	role: string;
	toolName?: string;
	/** Source messages; the first carries the unit's occurrence identity. */
	messages: AgentMessage[];
	call?: ToolCall;
	callMessage?: AgentMessage;
	timestamp: number;
}

interface Rendered {
	id: string;
	text: string;
	truncated: boolean;
	normalized: boolean;
	unverified: boolean;
}

interface Draft {
	id: string;
	kind: ClmArchiveKind;
	role: string;
	toolName?: string;
	label: string;
	text: string;
	truncated: boolean;
	legacyTruncated: boolean;
	failed: boolean;
	timestamp: number;
	lastSeen: number;
	order: number;
	turn: number;
	sources: Set<string>;
}

function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
}

function blocksText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "thinking" && typeof block.thinking === "string")
			parts.push(`[thinking]\n${block.thinking}`);
		else if (block.type === "image") parts.push("[image]");
		else if (block.type !== "toolCall") parts.push(`[${String(block.type)}]`);
	}
	return parts.join("\n");
}

/** Model-readable text of one non-tool message; empty when it carries nothing to recall. */
function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "bashExecution":
			return bashExecutionToText(message);
		case "pythonExecution":
			return pythonExecutionToText(message);
		case "fileMention":
			return message.files.map(file => `${file.path}\n${file.content}`).join("\n\n");
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default:
			return "content" in message ? blocksText(message.content) : "";
	}
}

/**
 * `name(args)` as one JSON line. With `verbatim`, multi-line string args (file bodies, edit
 * scripts, long commands) move into heredoc blocks after that line, so `:N-M` selectors and
 * excerpt line numbers address their real lines; the JSON keeps a `"<<field"` placeholder.
 */
function renderCall(call: ToolCall, verbatim: boolean): string {
	const json = JSON.stringify(call.arguments);
	// JSON escapes every newline: args whose JSON has no `\n` hold no multi-line string.
	if (!verbatim || !json?.includes("\\n")) return `${call.name}(${json})`;
	const blocks: string[] = [];
	const lift = (value: unknown, field: string): unknown => {
		if (typeof value === "string") {
			if (!value.includes("\n")) return value;
			// CRLF body lines (including a final CR before the appended LF) also occupy delimiters.
			const lines = new Set(value.split("\n").map(line => (line.endsWith("\r") ? line.slice(0, -1) : line)));
			let delimiter = "EOF";
			for (let n = 1; lines.has(delimiter); n++) delimiter = `EOF${n}`;
			blocks.push(`${field}: <<${delimiter}\n${value}${value.endsWith("\n") ? "" : "\n"}${delimiter}`);
			return `<<${field}`;
		}
		if (Array.isArray(value)) return value.map((item, index) => lift(item, `${field}[${index}]`));
		if (isRecord(value)) {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => {
					const nextField = /^[A-Za-z_$][\w$]*$/.test(key)
						? field
							? `${field}.${key}`
							: key
						: `${field}[${JSON.stringify(key)}]`;
					return [key, lift(item, nextField)];
				}),
			);
		}
		return value;
	};
	const head = JSON.stringify(lift(call.arguments, ""));
	return [`${call.name}(${head})`, ...blocks].join("\n");
}

function renderUnit(unit: Unit, verbatim = true): string {
	const messages = unit.messages;
	if (unit.kind !== "tool" && unit.kind !== "subagent") return messageText(messages[0]);
	const parts: string[] = [];
	const result = messages.find(message => message.role === "toolResult");
	if (unit.call) parts.push(renderCall(unit.call, verbatim));
	if (result?.role === "toolResult") {
		parts.push(`[toolResult ${result.toolName}${result.isError ? " error" : ""}]\n${blocksText(result.content)}`);
	} else if (unit.role === "bashExecution" || unit.role === "pythonExecution") {
		parts.push(messageText(messages[0]));
	}
	return parts.join("\n");
}

/** Oversized originals use full-content fingerprints; old lossy copies fall back to occurrence-scoped prefixes. */
function persistedForm(
	value: unknown,
	state: {
		truncated: boolean;
		legacy: boolean;
		unverified: boolean;
		normalized: boolean;
		tool: boolean;
		digests: string[];
	},
	hashes?: Readonly<Record<string, string>>,
	keys: (string | number)[] = [],
): unknown {
	if (typeof value === "string") {
		const key = persistenceTruncationKey(value);
		if (key === undefined) return value;
		state.normalized = true;
		const truncated = isPersistenceTruncatedString(value);
		state.truncated ||= truncated;
		const digest = hashes?.[JSON.stringify(keys)];
		if (state.legacy || (truncated && digest === undefined)) {
			state.unverified = true;
			return key;
		}
		const fullDigest = truncated ? digest! : Bun.hash(value).toString(16);
		state.digests.push(fullDigest);
		return `[archive-string:${fullDigest}]`;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item, index) => {
			const mapped = persistedForm(item, state, hashes, [...keys, index]);
			changed ||= mapped !== item;
			return mapped;
		});
		return changed ? next : value;
	}
	if (isRecord(value)) {
		const contentBlock = keys.length === 2 && keys[0] === "content";
		if (
			contentBlock &&
			(value.type === "image" ||
				value.type === "redactedThinking" ||
				value.type === "fallback" ||
				value.type === "anthropicServerTool")
		)
			return value;
		if (contentBlock && value.type === "toolCall" && !state.tool) return value;
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const ignored =
				(keys.length === 0 && typeof value.role === "string" && !Object.hasOwn(CLM_ARCHIVE_TEXT_FIELDS, key)) ||
				(contentBlock && key.endsWith("Signature"));
			const mapped = ignored ? item : persistedForm(item, state, hashes, [...keys, key]);
			changed ||= mapped !== item;
			next[key] = mapped;
		}
		return changed ? next : value;
	}
	return value;
}

function render(unit: Unit, hashes?: WeakMap<AgentMessage, Record<string, string>>, legacy = false): Rendered {
	const state = {
		truncated: false,
		legacy,
		unverified: false,
		normalized: false,
		tool: unit.kind === "tool" || unit.kind === "subagent",
		digests: [] as string[],
	};
	const comparable = unit.messages.map(message => persistedForm(message, state, hashes?.get(message)) as AgentMessage);
	let comparableCall = unit.call;
	if (unit.callMessage?.role === "assistant") {
		const index = unit.callMessage.content.findIndex(block => block === unit.call);
		comparableCall = persistedForm(unit.call, state, hashes?.get(unit.callMessage), ["content", index]) as ToolCall;
	}
	const text = renderUnit(unit);
	const changed =
		comparableCall !== unit.call || comparable.some((message, index) => message !== unit.messages[index]);
	// Ids hash the one-line JSON call form, so verbatim arg blocks in `text` never move an id.
	const hashText = changed
		? renderUnit({ ...unit, messages: comparable, call: comparableCall }, false)
		: unit.call
			? renderUnit(unit, false)
			: text;
	const identity = [unit.kind, unit.role, unit.toolName ?? "", hashText];
	if (state.unverified) identity.push(sourceKey(unit.messages[0]));
	if (state.digests.length > 0) identity.push(JSON.stringify(state.digests));
	const hash = Bun.hash(JSON.stringify(identity)).toString(16);
	return {
		id: `h${hash.padStart(16, "0").slice(0, 10)}`,
		text,
		truncated: state.truncated,
		normalized: state.normalized,
		unverified: state.unverified,
	};
}

/** Occurrence identity: one journal message, however many projections repeat it. */
function sourceKey(message: AgentMessage): string {
	if (message.role === "toolResult") return `toolResult:${message.toolCallId}`;
	return (
		sessionMessagePersistenceKey(message) ??
		`${message.role}:${message.timestamp}:${"customType" in message ? message.customType : ""}`
	);
}

function stringArg(args: unknown, key: string): string | undefined {
	return isRecord(args) && typeof args[key] === "string" ? args[key] : undefined;
}

function editPaths(args: unknown): string[] {
	const target = stringArg(args, "path");
	if (target) {
		const destinations =
			isRecord(args) && Array.isArray(args.edits)
				? args.edits.flatMap(edit => {
						const rename = stringArg(edit, "rename");
						return rename ? [rename] : [];
					})
				: [];
		return [target, ...destinations];
	}
	const input = stringArg(args, "input");
	if (!input) return [];
	for (const mode of ["hashline", "apply_patch", "sloppy"]) {
		try {
			const inspection = editInspect(mode, JSON.stringify(args));
			if (inspection.paths.length > 0)
				return [...inspection.paths, ...inspection.fileOps.flatMap(op => (op.to ? [op.to] : []))];
		} catch {
			/* Another supported edit syntax may match. */
		}
	}
	return [...input.matchAll(PATCH_HEADER_RE)].map(match => match[1].trim());
}

function toolLabel(name: string, args: unknown): string {
	if (name === "edit") {
		const paths = editPaths(args);
		if (paths.length > 0) return oneLine(`edit ${[...new Set(paths)].join(", ")}`);
	}
	if (name === "task" && isRecord(args) && Array.isArray(args.tasks)) {
		const names = args.tasks.map(task => stringArg(task, "name") ?? "task");
		return oneLine(`task ${names.join(", ")}`);
	}
	for (const key of LABEL_ARGS) {
		const value = stringArg(args, key);
		if (value) return oneLine(`${name} ${value}`);
	}
	return oneLine(`${name} ${JSON.stringify(args ?? {})}`);
}

/** Prefer tool-recorded host paths, which survive cwd changes and suffix resolution. Shell runs touch only the files they rewrote. */
function touchedPaths(unit: Unit, cwd: string): string[] {
	const name = unit.toolName;
	const args = unit.call?.arguments;
	if (name === "bash") {
		const message = unit.messages[0];
		if (message.role === "bashExecution") return shellMutatedPaths(message.command, cwd);
		const command = stringArg(args, "command");
		const dir = stringArg(args, "cwd");
		if (!command) return [];
		return shellMutatedPaths(
			command,
			dir === undefined ? cwd : dir.includes("://") ? undefined : path.resolve(cwd, dir),
		);
	}
	let paths: string[];
	if (name === "read" || name === "write") {
		const value = stringArg(args, "path");
		if (value?.includes("://")) return [];
		paths = value ? [name === "read" ? value.replace(READ_SELECTOR_RE, "") : value] : [];
	} else if (name === "edit") paths = editPaths(args);
	else return [];
	const result = unit.messages.find(message => message.role === "toolResult");
	const details = result?.role === "toolResult" && isRecord(result.details) ? result.details : undefined;
	if (details) {
		const recorded: string[] = [];
		if (name === "read" || name === "write") {
			const resolved = stringArg(details, "resolvedPath");
			if (resolved && path.isAbsolute(resolved)) recorded.push(resolved);
			const meta = isRecord(details.meta) ? details.meta : undefined;
			const source = meta && isRecord(meta.source) ? meta.source : undefined;
			const value = source?.type === "path" ? stringArg(source, "value") : undefined;
			if (value && path.isAbsolute(value)) recorded.push(value);
		} else {
			const files = Array.isArray(details.perFileResults) ? details.perFileResults : [details];
			for (const file of files) {
				for (const key of ["path", "sourcePath", "move"]) {
					const value = stringArg(file, key);
					if (value && path.isAbsolute(value)) recorded.push(value);
				}
			}
		}
		if (recorded.length > 0) paths = recorded;
	}
	return paths.filter(value => value !== "" && !value.includes("://")).map(value => path.resolve(cwd, value));
}

/**
 * Identity of an observation a later run can refresh: the same normalized shell command in the same
 * directory, or a read of one path with the same selector. Distinct content means distinct items.
 */
function observationKey(unit: Unit, cwd: string, touches: readonly string[]): string | undefined {
	const args = unit.call?.arguments;
	if (unit.toolName === "bash") {
		const message = unit.messages[0];
		const command = message.role === "bashExecution" ? message.command : stringArg(args, "command");
		const dir = message.role === "bashExecution" ? undefined : stringArg(args, "cwd");
		if (!command?.trim() || dir?.includes("://")) return undefined;
		return JSON.stringify(["bash", path.resolve(cwd, dir ?? "."), command.trim().replace(/\s+/g, " ")]);
	}
	if (unit.toolName !== "read" || touches.length !== 1) return undefined;
	const selector = stringArg(args, "path")?.match(READ_SELECTOR_RE)?.[0] ?? "";
	const legacy = isRecord(args) ? [args.offset, args.limit, args.sel] : [];
	return JSON.stringify(["read", touches[0], selector, ...legacy]);
}

/** Split one message array into archive units; tool calls without a result yet are skipped. */
function scanUnits(messages: readonly AgentMessage[]): Unit[] {
	const units: Unit[] = [];
	const calls = new Map<string, { assistant: AgentMessage; call: ToolCall }>();
	for (const message of messages) {
		switch (message.role) {
			case "assistant": {
				for (const block of message.content) {
					if (block.type === "toolCall") calls.set(block.id, { assistant: message, call: block });
				}
				if (message.content.some(block => block.type !== "toolCall"))
					units.push({ kind: "assistant", role: "assistant", messages: [message], timestamp: message.timestamp });
				break;
			}
			case "toolResult": {
				const call = calls.get(message.toolCallId);
				calls.delete(message.toolCallId);
				units.push({
					kind: message.toolName === "task" ? "subagent" : "tool",
					role: "toolResult",
					toolName: message.toolName,
					messages: [message],
					call: call?.call,
					callMessage: call?.assistant,
					timestamp: message.timestamp,
				});
				break;
			}
			case "user":
				units.push({ kind: "user", role: "user", messages: [message], timestamp: message.timestamp });
				break;
			case "clmNote":
				if (message.content.trim() !== "")
					units.push({ kind: "note", role: "clmNote", messages: [message], timestamp: message.timestamp });
				break;
			case "bashExecution":
			case "pythonExecution":
				if (!message.excludeFromContext) {
					units.push({
						kind: "tool",
						role: message.role,
						toolName: message.role === "bashExecution" ? "bash" : "python",
						messages: [message],
						timestamp: message.timestamp,
					});
				}
				break;
			case "branchSummary":
			case "compactionSummary":
				if (message.summary.trim() !== "")
					units.push({ kind: "summary", role: message.role, messages: [message], timestamp: message.timestamp });
				break;
			case "custom":
			case "hookMessage":
				if (
					message.customType !== CLM_FEEDBACK_MESSAGE_TYPE &&
					message.customType !== CLM_OUT_OF_CONTEXT_INDEX_MESSAGE_TYPE
				)
					units.push({
						kind:
							message.customType === CLM_HANDOFF_MESSAGE_TYPE ||
							message.customType === CLM_PARENT_MANIFEST_MESSAGE_TYPE
								? "note"
								: "custom",
						role: message.customType,
						messages: [message],
						timestamp: message.timestamp,
					});
				break;
			default:
				units.push({ kind: "custom", role: message.role, messages: [message], timestamp: message.timestamp });
		}
	}
	return units;
}

function unitLabel(unit: Unit, text: string): string {
	if (unit.call) return toolLabel(unit.call.name, unit.call.arguments);
	const message = unit.messages[0];
	if (message.role === "bashExecution") return oneLine(`bash ${message.command}`);
	if (message.role === "pythonExecution") return oneLine(`python ${message.code}`);
	if (message.role === "fileMention") return oneLine(`@${message.files.map(file => file.path).join(", @")}`);
	const first = text.split("\n").find(line => line.trim() !== "" && line !== "[thinking]");
	return oneLine(first ?? `[${unit.role}]`);
}

/** Journal messages of the active branch after the last reset, in order. */
function journalMessages(entries: readonly SessionEntry[]): {
	messages: AgentMessage[];
	projections: AgentMessage[][];
	hashes: WeakMap<AgentMessage, Record<string, string>>;
} {
	const reset = entries.findLastIndex(entry => entry.type === "reset_boundary");
	const messages: AgentMessage[] = [];
	const projections: AgentMessage[][] = [];
	const hashes = new WeakMap<AgentMessage, Record<string, string>>();
	for (const entry of entries.slice(reset + 1)) {
		if (entry.type === "message") {
			messages.push(entry.message);
			if (entry.archiveStringHashes) hashes.set(entry.message, entry.archiveStringHashes);
		} else if (entry.type === "custom_message") {
			const message = customMessageEntryMessage(entry);
			if (message) messages.push(message);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
		} else if (entry.type === "compaction" && entry.summary) {
			messages.push(createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp));
		} else if (entry.type === "context_projection") projections.push(getContextProjectionMessages(entry));
	}
	return { messages, projections, hashes };
}

class ArchiveSnapshot implements ClmArchive {
	readonly items: readonly ClmArchiveItem[];
	readonly #byId: ReadonlyMap<string, ClmArchiveItem>;
	readonly #idsFor: ((messages: readonly AgentMessage[]) => string[]) | undefined;

	constructor(items: ClmArchiveItem[], idsFor?: (messages: readonly AgentMessage[]) => string[]) {
		this.items = items;
		this.#byId = new Map(items.map(item => [item.id, item]));
		this.#idsFor = idsFor;
	}

	get(id: string): ClmArchiveItem | undefined {
		return this.#byId.get(id);
	}

	idsFor(messages: readonly AgentMessage[]): string[] {
		if (this.#idsFor) return this.#idsFor(messages).filter(id => this.#byId.has(id));
		const ids = new Set<string>();
		for (const unit of scanUnits(messages)) {
			const { id } = render(unit);
			if (this.#byId.has(id)) ids.add(id);
		}
		return [...ids];
	}
}

/** A view without `kinds` (e.g. a reviewer child that must not see parent reasoning); ids are unchanged. */
export function excludeArchiveKinds(archive: ClmArchive, kinds: readonly ClmArchiveKind[]): ClmArchive {
	if (kinds.length === 0) return archive;
	return new ArchiveSnapshot(
		archive.items.filter(item => !kinds.includes(item.kind)),
		messages => archive.idsFor(messages),
	);
}

/** Build the archive of `manager`'s active branch plus the live context. */
export function buildClmArchive(manager: SessionManager, options: ClmArchiveOptions = {}): ClmArchive {
	const cwd = manager.getCwd();
	const tokenizer = options.tokenizer ?? new Tokenizer();
	const live = options.live ?? manager.buildSessionContext().messages;
	const { messages, projections, hashes } = journalMessages(manager.getBranch());
	const drafts = new Map<string, Draft>();
	const aliases = new Map<string, string>();
	const events: {
		draft: Draft;
		timestamp: number;
		order: number;
		touches: string[];
		mutates: boolean;
		observes: string | undefined;
		succeeded: boolean;
	}[] = [];

	const add = (unit: Unit): Draft => {
		const rendered = render(unit, hashes);
		const source = sourceKey(unit.messages[0]);
		const legacyId = rendered.normalized ? render(unit, undefined, true).id : rendered.id;
		const alias = aliases.get(legacyId);
		const previous = alias ? drafts.get(alias) : undefined;
		const id = previous && (previous.legacyTruncated || rendered.unverified) ? previous.id : rendered.id;
		let draft = drafts.get(id);
		if (!draft) {
			draft = {
				id,
				kind: unit.kind,
				role: unit.role,
				toolName: unit.toolName,
				label: unitLabel(unit, rendered.text),
				text: rendered.text,
				truncated: rendered.truncated,
				legacyTruncated: rendered.truncated && rendered.unverified,
				failed: false,
				timestamp: unit.timestamp,
				lastSeen: unit.timestamp,
				order: drafts.size,
				turn: 0,
				sources: new Set(),
			};
			drafts.set(id, draft);
		} else if (draft.truncated && !rendered.truncated) {
			draft.text = rendered.text;
			draft.truncated = false;
			draft.legacyTruncated = false;
		}
		if (!draft.sources.has(source)) {
			const touches = touchedPaths(unit, cwd);
			const succeeded = !unit.messages.some(
				message =>
					(message.role === "toolResult" && message.isError) ||
					(message.role === "bashExecution" && (message.exitCode !== 0 || message.cancelled)),
			);
			if (!succeeded) draft.failed = true;
			events.push({
				draft,
				timestamp: unit.timestamp,
				order: events.length,
				touches,
				mutates: (unit.toolName === "write" || unit.toolName === "edit" || unit.toolName === "bash") && succeeded,
				observes: observationKey(unit, cwd, touches),
				succeeded,
			});
		}
		aliases.set(legacyId, draft.id);
		draft.sources.add(source);
		draft.lastSeen = Math.max(draft.lastSeen, unit.timestamp);
		return draft;
	};

	for (const unit of scanUnits(messages)) add(unit);
	for (const projection of projections) for (const unit of scanUnits(projection)) add(unit);
	const inContext = new Set(scanUnits(live).map(unit => add(unit).id));

	const ordered = [...drafts.values()].sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
	const chronology = events.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
	let turn = 0;
	const seen = new Set<string>();
	for (const event of chronology) {
		if (event.draft.kind === "user") turn++;
		if (!seen.has(event.draft.id)) event.draft.turn = turn;
		seen.add(event.draft.id);
	}
	// Later changes, keyed by path or observation, with their chronology index; the nearest one supersedes.
	const supersededBy = new Map<string, string>();
	const nextMutation = new Map<string, { id: string; index: number }>();
	const nextObservation = new Map<string, { id: string; index: number }>();
	const latest = new Set<string>();
	for (let i = chronology.length - 1; i >= 0; i--) {
		const event = chronology[i];
		const draft = event.draft;
		if (!latest.has(draft.id)) {
			const mutation = event.touches.length > 0 ? nextMutation.get(event.touches[0]) : undefined;
			const replaced =
				mutation && event.touches.every(value => nextMutation.get(value)?.id === mutation.id)
					? mutation
					: undefined;
			const rerun = event.observes === undefined ? undefined : nextObservation.get(event.observes);
			const later = replaced && rerun ? (replaced.index < rerun.index ? replaced : rerun) : (replaced ?? rerun);
			if (later && later.id !== draft.id) supersededBy.set(draft.id, later.id);
			latest.add(draft.id);
		}
		if (event.mutates) for (const value of event.touches) nextMutation.set(value, { id: draft.id, index: i });
		if (event.observes !== undefined && event.succeeded)
			nextObservation.set(event.observes, { id: draft.id, index: i });
	}
	const items = ordered.map((draft): ClmArchiveItem => {
		const superseded = supersededBy.get(draft.id);
		return {
			id: draft.id,
			kind: draft.kind,
			role: draft.role,
			...(draft.toolName ? { toolName: draft.toolName } : {}),
			label: draft.label,
			text: draft.text,
			tokens: tokenizer.countTokens(draft.text),
			timestamp: draft.timestamp,
			lastSeen: draft.lastSeen,
			occurrences: draft.sources.size,
			turn: draft.turn,
			inContext: inContext.has(draft.id),
			...(superseded ? { supersededBy: superseded } : {}),
			...(draft.truncated ? { truncated: true } : {}),
			...(draft.failed ? { failed: true } : {}),
		};
	});
	return new ArchiveSnapshot(items, messages => {
		const ids = new Set<string>();
		for (const unit of scanUnits(messages)) {
			const current = render(unit, hashes).id;
			const id = drafts.has(current) ? current : aliases.get(render(unit, undefined, true).id);
			if (id) ids.add(id);
		}
		return [...ids];
	});
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** Status markers shown after an item's size. */
function renderArchiveMarkers(item: ClmArchiveItem): string {
	const markers: string[] = [];
	if (item.inContext) markers.push("in-context");
	if (item.supersededBy) markers.push(`superseded-by ${item.supersededBy}`);
	if (item.truncated) markers.push("truncated");
	if (item.occurrences > 1) markers.push(`seen ×${item.occurrences}`);
	return markers.length > 0 ? ` [${markers.join("; ")}]` : "";
}

/** One manifest line: id, time, turn, kind, size, markers, label. */
export function renderArchiveManifestLine(item: ClmArchiveItem): string {
	const kind = item.toolName && item.kind !== "subagent" ? `${item.kind}:${item.toolName}` : item.kind;
	const time = Number.isFinite(item.timestamp) ? `${new Date(item.timestamp).toISOString().slice(0, 19)}Z` : "?";
	return `${item.id} ${time} t${item.turn} ${kind} ${formatTokens(item.tokens)}tok${renderArchiveMarkers(item)} — ${item.label}`;
}

export interface ClmArchiveManifestOptions {
	offset?: number;
	limit?: number;
	/** Route the expand/next hints name; defaults to `context://self/archive`. */
	routePrefix?: string;
}

export const CLM_ARCHIVE_ROUTE = "context://self/archive";
export const CLM_ARCHIVE_MANIFEST_LIMIT = 200;

/** A chronological page of the archive with paging and expansion hints. */
export function renderArchiveManifest(archive: ClmArchive, options: ClmArchiveManifestOptions = {}): string {
	const route = options.routePrefix ?? CLM_ARCHIVE_ROUTE;
	const items = archive.items;
	const offset = Math.min(Math.max(0, options.offset ?? 0), items.length);
	const limit = Math.max(1, options.limit ?? CLM_ARCHIVE_MANIFEST_LIMIT);
	const page = items.slice(offset, offset + limit);
	const inContext = items.filter(item => item.inContext).length;
	const superseded = items.filter(item => item.supersededBy).length;
	const tokens = items.reduce((sum, item) => sum + item.tokens, 0);
	const lines = [
		`# CLM archive: ${items.length} items (${inContext} in context, ${superseded} superseded), ~${formatTokens(tokens)} tokens; chronological; ids are stable across revisions and reloads.`,
		`# Items ${page.length === 0 ? 0 : offset + 1}–${offset + page.length} of ${items.length}.${offset + page.length < items.length ? ` Next page: ${route}?offset=${offset + page.length}&limit=${limit}` : ""}`,
		`# Expand verbatim: ${route}/<id> (line selectors :N-M work). Search: ${route}?q=<terms> (add &regex=1 for a regex).`,
		...page.map(renderArchiveManifestLine),
	];
	return lines.join("\n");
}

/** Tools whose output a rerun reproduces while the files they looked at stay unchanged. */
const REPRODUCIBLE_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, find: true };
/** Shell runs: a non-zero exit is an observed outcome worth indexing, not a failed call. */
const SHELL_TOOLS: Record<string, true> = { bash: true, python: true, eval: true };
/** Ids a collapsed line starts with; leftover budget extends it afterwards. */
const INDEX_GROUP_IDS = 8;
/** Consecutive entries that may fail to fit before selection stops measuring. */
const INDEX_MAX_MISSES = 16;

interface IndexEntry {
	/**
	 * 0 user messages, notes, summaries; 1 unreproducible output (shell, web, subagents); 2 assistant
	 * text, which narrates 0 and 1; 3 reproducible reads/searches; 4 failed calls.
	 */
	tier: number;
	newest: number;
	items: ClmArchiveItem[];
	render(ids: number): string;
}

export interface ClmOutOfContextIndexOptions {
	/** Session cwd; paths under it render relative. */
	cwd: string;
	/** Whether a candidate index body fits the caller's bound, measured however the caller lowers it. */
	fits(content: string): boolean;
}

/** `dir/prefix*suffix` covering paths that share one directory. */
function pathPattern(paths: readonly string[]): string {
	const names = paths.map(value => path.posix.basename(value));
	let head = names[0];
	for (const name of names) while (!name.startsWith(head)) head = head.slice(0, -1);
	let tail = names[0].slice(head.length);
	for (const name of names)
		while (!name.endsWith(tail) || name.length - tail.length < head.length) tail = tail.slice(1);
	const dir = path.posix.dirname(paths[0]);
	const name = names.every(value => value === names[0]) ? names[0] : `${head}*${tail}`;
	return dir === "." ? name : `${dir}/${name}`;
}

/**
 * Index of the archive items missing from the effective context, or undefined when none are.
 * What is hardest to recover comes first (user messages and notes, then shell, web, subagent
 * and other unreproducible output, then assistant text, then reads and searches a rerun
 * reproduces), newest first
 * within a tier. Reproducible items of one tool and directory collapse into one line, failed
 * calls into a count, and every user turn that lost items keeps a line while one fits.
 */
export function renderOutOfContextIndex(
	items: readonly ClmArchiveItem[],
	options: ClmOutOfContextIndexOptions,
): string | undefined {
	const lost = items
		.filter(item => !item.inContext)
		.toReversed()
		.sort((a, b) => b.lastSeen - a.lastSeen);
	if (lost.length === 0) return undefined;
	const prefix = `${options.cwd.replace(/\/+$/, "")}/`;
	const relative = (label: string) => (prefix.length > 1 ? label.replaceAll(prefix, "") : label);
	const single = (tier: number, item: ClmArchiveItem): IndexEntry => ({
		tier,
		newest: item.lastSeen,
		items: [item],
		render: () => `${item.id} ${item.kind} ${item.tokens}tok — ${relative(item.label)}`,
	});
	const collapsed = (tier: number, group: ClmArchiveItem[], what: string): IndexEntry => ({
		tier,
		newest: group[0].lastSeen,
		items: group,
		render: ids => {
			const listed = group.slice(0, ids).map(item => item.id);
			if (ids < group.length) listed.push(ids === 0 ? `${group.length} ids via search` : `… +${group.length - ids}`);
			const tokens = formatTokens(group.reduce((sum, item) => sum + item.tokens, 0));
			return `${what} ${tokens}tok (${listed.join(", ")})`;
		},
	});

	const entries: IndexEntry[] = [];
	const groups = new Map<string, ClmArchiveItem[]>();
	const failed: ClmArchiveItem[] = [];
	for (const item of lost) {
		const tool = item.toolName ?? "";
		if (item.failed && !SHELL_TOOLS[tool]) failed.push(item);
		else if (item.kind === "user" || item.kind === "note" || item.kind === "summary") entries.push(single(0, item));
		else if (item.kind === "assistant") entries.push(single(2, item));
		else if (REPRODUCIBLE_TOOLS[tool] && !item.supersededBy && !item.label.includes("://")) {
			const target = relative(item.label.slice(tool.length + 1)).replace(READ_SELECTOR_RE, "");
			const key = `${tool}\0${tool === "read" ? path.posix.dirname(target) : ""}`;
			const group = groups.get(key);
			if (group) group.push(item);
			else groups.set(key, [item]);
		} else entries.push(single(1, item));
	}
	for (const group of groups.values()) {
		const tool = group[0].toolName ?? "";
		if (group.length === 1) entries.push(single(3, group[0]));
		else if (tool === "read") {
			const targets = group.map(item => relative(item.label.slice(5)).replace(READ_SELECTOR_RE, ""));
			entries.push(collapsed(3, group, `${group.length}× read ${pathPattern(targets)}`));
		} else entries.push(collapsed(3, group, `${group.length}× ${tool}, newest ${relative(group[0].label)}`));
	}
	// A failed call stays visible only when nothing else shows what its turn did.
	const represented = new Set(entries.flatMap(entry => entry.items.map(item => item.turn)));
	const counted: ClmArchiveItem[] = [];
	for (const item of failed) {
		if (represented.has(item.turn)) counted.push(item);
		else {
			entries.push(single(4, item));
			represented.add(item.turn);
		}
	}
	if (counted.length > 0)
		entries.push(collapsed(4, counted, `${counted.length} failed tool call${counted.length === 1 ? "" : "s"}`));

	const rank = (a: IndexEntry, b: IndexEntry) => a.tier - b.tier || b.newest - a.newest;
	entries.sort(rank);
	// Each turn's best entry goes first, newest turn first, so no turn that lost items vanishes.
	const best = new Map<number, IndexEntry>();
	for (const entry of entries) for (const item of entry.items) if (!best.has(item.turn)) best.set(item.turn, entry);
	const turnFirst = [...best].sort((a, b) => b[0] - a[0]).map(([, entry]) => entry);

	const shown = new Map<IndexEntry, number>();
	const body = () => {
		const lines = [...shown].sort(([a], [b]) => rank(a, b)).map(([entry, ids]) => entry.render(ids));
		const hidden = lost.length - [...shown.keys()].reduce((sum, entry) => sum + entry.items.length, 0);
		return [
			"CLM out-of-context archive index (historical data; hardest to recover first, newest first within each tier):",
			...lines,
			...(hidden > 0 ? [`+${hidden} more items — search ${CLM_ARCHIVE_ROUTE}?q=`] : []),
		].join("\n");
	};
	let misses = 0;
	for (const entry of new Set([...turnFirst, ...entries])) {
		let ids = Math.min(entry.items.length, INDEX_GROUP_IDS);
		for (;;) {
			shown.set(entry, ids);
			if (options.fits(body())) break;
			shown.delete(entry);
			if (ids === 0 || entry.items.length === 1) break;
			ids = Math.floor(ids / 2);
		}
		if (shown.has(entry)) misses = 0;
		else if (++misses >= INDEX_MAX_MISSES) break;
	}
	// Spend what is left on the ids of collapsed lines.
	for (const [entry, ids] of shown) {
		let low = ids;
		let high = entry.items.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			shown.set(entry, middle);
			if (options.fits(body())) low = middle;
			else high = middle - 1;
		}
		shown.set(entry, low);
	}
	return body();
}
