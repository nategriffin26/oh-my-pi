/**
 * Parent → child context handoff for the task tool (CLM sessions).
 *
 * The parent names archive items (`h<id>`) or blocks of its latest `context://self` snapshot
 * (`b<N>`); the host copies them verbatim, with provenance, into one editable seed message in the
 * child. The parent's original user requirements are pinned unless opted out, independent
 * reviewers never receive parent reasoning, and the child gets an always-visible manifest of the
 * parent's other items plus a read-only `context://parent/archive*` grant to pull more.
 */
import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { TaskHandoffMode, TaskHandoffSummary, TaskItem } from "@oh-my-pi/pi-tui/tools/task";
import { escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import handoffSeedTemplate from "../prompts/system/subagent-handoff.md" with { type: "text" };
import {
	type ClmArchive,
	type ClmArchiveItem,
	type ClmArchiveKind,
	excludeArchiveKinds,
	renderArchiveManifestLine,
} from "../session/clm-archive";
import type { ClmContextAccess, ClmParentArchiveGrant } from "../session/clm-types";
import type { AgentDefinition } from "./types";

/** Soft cap on the verbatim seed copied into one child. */
export const HANDOFF_SOFT_CAP_TOKENS = 24_000;
/** Pinned user requirements: at most this many messages and tokens (first message + most recent). */
export const HANDOFF_PIN_MAX_ITEMS = 6;
export const HANDOFF_PIN_MAX_TOKENS = 8_000;
/** Manifest lines of the parent's other items shown in the child's system prompt. */
export const HANDOFF_MANIFEST_MAX_LINES = 60;
/** Parent reasoning an independent reviewer never receives: assistant text, model notes, summaries. */
export const REVIEWER_EXCLUDED_KINDS: readonly ClmArchiveKind[] = ["assistant", "note", "summary"];

const REVIEWER_NAME_RE =
	/(?:^|[^a-z])(?:review|reviewer|reviewing|verify|verifier|verifying|verification|audit|auditor|auditing|critic|critique|criticism)(?:$|[^a-z])/i;
const HANDOFF_REF_RE = /^(h[0-9a-f]{10}|b\d+)(?::(\d+)-(\d+))?$/;
const HANDOFF_MODES: Record<TaskHandoffMode, true> = { curated: true, brief: true, fork: true };
const REF_HELP =
	"Use h<id> archive ids (list: read context://self/archive; search: context://self/archive?q=<terms>) or b<N> block ids from your latest context://self read, optionally with a :N-M line range (e.g. h0123456789:10-40).";

export interface HandoffRef {
	raw: string;
	id: string;
	block: boolean;
	range?: { start: number; end: number };
}

/** The per-task handoff fields as the caller sent them. */
export interface TaskHandoffRequest {
	refs?: readonly string[];
	mode?: TaskHandoffMode;
	pinRequirements?: boolean;
}

/** One handed-off (or omitted) item, for the parent-visible cost line and the child seed. */
export interface HandoffEntry {
	id: string;
	kind: ClmArchiveKind;
	tokens: number;
	pinned: boolean;
	/** `N-M` when only those lines of the item were copied. */
	lines?: string;
}

export interface ResolvedTaskHandoff {
	/** `brief`: no seed or manifest, only the read-only parent-archive grant (CLM parents). */
	mode: TaskHandoffMode;
	/** Reviewer policy applied: parent reasoning kinds excluded from seed, manifest, and grant. */
	independent: boolean;
	/** Child seed message (curated mode, when anything was copied). */
	seed?: string;
	/** Child system-prompt manifest lines of the parent's other items (curated mode). */
	manifest?: string;
	grant?: ClmParentArchiveGrant;
	included: HandoffEntry[];
	/** Items that did not fit the soft cap (or the pin budget), in priority order. */
	omitted: HandoffEntry[];
	/** Requested ids withheld by reviewer policy. */
	excluded: string[];
	/** Estimated tokens of the seed (curated) or of the parent's in-context items (fork). */
	tokens: number;
	manifestTokens: number;
	/** Soft cap the seed was fitted to (0 for fork). */
	capTokens: number;
}

/** Parse one handoff ref; `undefined` when it is not a ref. */
export function parseHandoffRef(raw: string): HandoffRef | undefined {
	const match = HANDOFF_REF_RE.exec(raw.trim());
	if (!match) return undefined;
	const ref: HandoffRef = { raw: raw.trim(), id: match[1], block: match[1].startsWith("b") };
	if (match[2] !== undefined) ref.range = { start: Number(match[2]), end: Number(match[3]) };
	return ref;
}

/** Shape errors for one task's handoff fields; `label` names the task (e.g. "Task 2 (`Scout`)"). */
export function validateHandoffFields(
	item: Pick<TaskItem, "handoff" | "handoffMode" | "pinRequirements">,
	label: string,
): string | undefined {
	if (
		item.handoffMode !== undefined &&
		(typeof item.handoffMode !== "string" || !Object.hasOwn(HANDOFF_MODES, item.handoffMode))
	) {
		return `${label} has an invalid \`handoffMode\` ${JSON.stringify(item.handoffMode)}. Use "curated", "brief", or "fork".`;
	}
	if (item.pinRequirements !== undefined && typeof item.pinRequirements !== "boolean") {
		return `${label} has an invalid \`pinRequirements\`; use true or false.`;
	}
	if (item.handoff === undefined) return undefined;
	if (!Array.isArray(item.handoff)) return `${label} has an invalid \`handoff\`; pass an array of refs. ${REF_HELP}`;
	if (item.handoff.length > 0 && item.handoffMode === "brief") {
		return `${label} sets \`handoffMode: "brief"\`, which copies no parent items; drop \`handoff\` or use "curated".`;
	}
	if (item.handoff.length > 0 && item.handoffMode === "fork") {
		return `${label} sets \`handoffMode: "fork"\`, which already carries the full parent transcript; drop \`handoff\`.`;
	}
	for (const raw of item.handoff) {
		const ref = typeof raw === "string" ? parseHandoffRef(raw) : undefined;
		if (!ref) return `${label} has an invalid handoff ref ${JSON.stringify(raw)}. ${REF_HELP}`;
		if (
			ref.range &&
			(!Number.isSafeInteger(ref.range.start) ||
				!Number.isSafeInteger(ref.range.end) ||
				ref.range.start < 1 ||
				ref.range.end < ref.range.start)
		) {
			return `${label} has an invalid line range in handoff ref ${JSON.stringify(raw)}; use :N-M with 1 <= N <= M.`;
		}
	}
	return undefined;
}

/**
 * Independent reviewers get requirements and artifacts only. The agent's `independent`
 * frontmatter decides; without it, role tokens (including camel-case boundaries) in its name decide.
 */
export function isIndependentAgent(agent: Pick<AgentDefinition, "name" | "independent">): boolean {
	return (
		agent.independent ??
		REVIEWER_NAME_RE.test(agent.name.replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2"))
	);
}

interface Selection {
	item: ClmArchiveItem;
	order: number;
	pinned: boolean;
	/** Pinned latest user message: the request the parent was answering when it delegated. */
	trigger?: boolean;
	range?: { start: number; end: number; total: number };
	text: string;
	tokens: number;
}

function selectLines(item: ClmArchiveItem, range: { start: number; end: number }, raw: string) {
	const lines = item.text.split("\n");
	if (range.start > lines.length) {
		throw new Error(`Handoff ref ${raw}: ${item.id} has only ${lines.length} lines.`);
	}
	const end = Math.min(range.end, lines.length);
	return {
		text: lines.slice(range.start - 1, end).join("\n"),
		range: { start: range.start, end, total: lines.length },
	};
}

/** Archive items one ref names: an `h` id is one item; a whole `b` block is every item it renders. */
function resolveRef(
	access: ClmContextAccess,
	archive: ClmArchive,
	raw: string,
): { items: ClmArchiveItem[]; ref: HandoffRef } {
	const ref = parseHandoffRef(raw);
	if (!ref) throw new Error(`Invalid handoff ref ${JSON.stringify(raw)}. ${REF_HELP}`);
	if (!ref.block) {
		const item = archive.get(ref.id);
		if (!item) {
			throw new Error(
				`Unknown handoff ref ${ref.raw}: no such item in your archive. List ids with read context://self/archive or search context://self/archive?q=<terms>.`,
			);
		}
		return { items: [item], ref };
	}
	const block = access.snapshotBlockMessages(ref.id);
	if (!block) {
		throw new Error(
			`Unknown handoff ref ${ref.raw}: no block ${ref.id} in your latest context://self snapshot (block ids shift on every revision). Re-read context://self, or use stable h<id> ids from context://self/archive.`,
		);
	}
	const ids = archive.idsFor(block.messages);
	if (ids.length === 0) throw new Error(`Handoff ref ${ref.raw}: block ${ref.id} has no archived content.`);
	if (ids.length > 1 && ref.range) {
		throw new Error(
			`Handoff ref ${ref.raw}: block ${ref.id} spans ${ids.length} archive items (${ids.join(", ")}); a :N-M range needs one item — range one of those h ids instead.`,
		);
	}
	const items = ids.map(id => {
		const item = archive.get(id);
		if (!item) throw new Error(`Handoff ref ${ref.raw}: block ${ref.id} maps to unknown archive item ${id}.`);
		return item;
	});
	return { items, ref };
}

/** Expand refs to archive selections in request order, deduplicated (a whole item wins over its ranges). */
function requestedSelections(
	access: ClmContextAccess,
	archive: ClmArchive,
	refs: readonly string[],
	order: Map<string, number>,
	tokenizer: Tokenizer,
): Selection[] {
	const selections: Selection[] = [];
	const whole = new Set<string>();
	const push = (item: ClmArchiveItem, ref?: HandoffRef) => {
		if (whole.has(item.id)) return;
		const base = { item, order: order.get(item.id) ?? 0, pinned: false };
		if (!ref?.range) {
			whole.add(item.id);
			for (let i = selections.length - 1; i >= 0; i--)
				if (selections[i].item.id === item.id) selections.splice(i, 1);
			selections.push({ ...base, text: item.text, tokens: item.tokens });
			return;
		}
		const sliced = selectLines(item, ref.range, ref.raw);
		const key = `${sliced.range.start}-${sliced.range.end}`;
		if (
			selections.some(
				entry => entry.item.id === item.id && entry.range && `${entry.range.start}-${entry.range.end}` === key,
			)
		) {
			return;
		}
		selections.push({ ...base, ...sliced, tokens: tokenizer.countTokens(sliced.text) });
	};
	for (const raw of refs) {
		const { items, ref } = resolveRef(access, archive, raw);
		for (const item of items) push(item, ref);
	}
	return selections;
}

/** The parent's user messages that started and steered the work: first one plus the most recent. */
function requirementCandidates(archive: ClmArchive): ClmArchiveItem[] {
	const users = archive.items.filter(item => item.kind === "user");
	if (users.length <= HANDOFF_PIN_MAX_ITEMS) return users;
	return [users[0], ...users.slice(users.length - (HANDOFF_PIN_MAX_ITEMS - 1))];
}

function fenceFor(text: string): string {
	let longest = 0;
	for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
	return "`".repeat(Math.max(3, longest + 1));
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function renderSelection(selection: Selection): string {
	const { item } = selection;
	const time = Number.isFinite(item.timestamp) ? `${new Date(item.timestamp).toISOString().slice(0, 19)}Z` : "?";
	const kind = item.toolName && item.kind !== "subagent" ? `${item.kind}:${item.toolName}` : item.kind;
	const header = [
		`### ${item.id}`,
		kind,
		item.label,
		time,
		`${formatTokens(selection.tokens)} tok`,
		...(selection.range ? [`lines ${selection.range.start}-${selection.range.end} of ${selection.range.total}`] : []),
		...(selection.trigger
			? [
					"pinned: latest user→parent request, which the parent was answering when it delegated (not addressed to you)",
				]
			: selection.pinned
				? ["pinned: user→parent message (background requirement, not addressed to you)"]
				: []),
		...(item.kind === "assistant" ? ["quoted parent assistant output"] : []),
		...(item.supersededBy ? [`stale: superseded by ${item.supersededBy}`] : []),
		...(item.truncated ? ["persistence-truncated copy"] : []),
	].join(" · ");
	const fence = fenceFor(selection.text);
	return `${header}\n${fence}\n${selection.text}\n${fence}`;
}

function renderManifest(archive: ClmArchive, handed: ReadonlySet<string>): string | undefined {
	const others = archive.items.filter(item => !handed.has(item.id));
	if (others.length === 0) return undefined;
	const shown = others.slice(-HANDOFF_MANIFEST_MAX_LINES);
	const older = others.length - shown.length;
	return [
		`${others.length} parent item(s) not copied to you; ${older > 0 ? `latest ${shown.length} shown (page older ones with context://parent/archive?offset=0)` : "all shown"}, chronological:`,
		...shown.map(renderArchiveManifestLine),
	].join("\n");
}

export interface ResolveTaskHandoffOptions {
	/** The spawning parent's CLM capability; absent or disabled → no curated handoff. */
	access: ClmContextAccess | undefined;
	request: TaskHandoffRequest | undefined;
	agent: Pick<AgentDefinition, "name" | "independent">;
	/** Parent session file; fork mode needs a persisted transcript. */
	parentSessionFile: string | null;
	capTokens?: number;
	/** Mode for a CLM parent's spawn that names neither a mode nor refs (`compaction.clmHandoffDefault`). */
	defaultMode?: TaskHandoffMode;
}

/**
 * Resolve a spawn's handoff on the parent side. `undefined` = no CLM parent and no handoff fields
 * (the assignment and shared context only); a CLM parent's brief spawn carries only the read-only
 * archive grant. Throws an Error naming the bad ref and how to get valid ids.
 */
export function resolveTaskHandoff(options: ResolveTaskHandoffOptions): ResolvedTaskHandoff | undefined {
	const { access, request, agent } = options;
	const clmEnabled = access?.isEnabled() === true;
	const refs = request?.refs ?? [];
	const independent = isIndependentAgent(agent);
	// Refs imply curated; a CLM parent's other spawns take the configured default, where a defaulted
	// fork that cannot happen (independent reviewer, in-memory parent) becomes curated; a non-CLM
	// parent keeps today's brief-only spawn.
	const configured = options.defaultMode ?? "curated";
	const fallback = configured === "fork" && (independent || !options.parentSessionFile) ? "curated" : configured;
	const mode = request?.mode ?? (refs.length > 0 ? "curated" : clmEnabled ? fallback : "brief");
	const excludeKinds = independent ? REVIEWER_EXCLUDED_KINDS : [];
	if (mode === "brief") {
		if (refs.length > 0)
			throw new Error('handoffMode "brief" copies no parent items; drop `handoff` or use "curated".');
		if (!access || !clmEnabled) return undefined;
		return {
			mode,
			independent,
			grant: { access, ownerSessionId: access.ownerSessionId, excludeKinds },
			included: [],
			omitted: [],
			excluded: [],
			tokens: 0,
			manifestTokens: 0,
			capTokens: 0,
		};
	}
	if (mode === "fork") {
		if (!clmEnabled)
			throw new Error(
				"Fork handoff needs this session's CLM context (compaction.experimentalClm); use the brief and shared context instead.",
			);
		if (refs.length > 0)
			throw new Error('handoffMode "fork" already carries the full parent transcript; drop `handoff`.');
		if (independent) {
			throw new Error(
				`Agent "${agent.name}" is an independent reviewer; a fork would hand it the parent's reasoning. Use "curated" (requirements + artifacts) or "brief".`,
			);
		}
		if (!options.parentSessionFile)
			throw new Error('handoffMode "fork" needs a persisted parent session; this session is in-memory.');
		const tokens = clmEnabled
			? access.archive().items.reduce((sum, item) => sum + (item.inContext ? item.tokens : 0), 0)
			: 0;
		return { mode, independent, included: [], omitted: [], excluded: [], tokens, manifestTokens: 0, capTokens: 0 };
	}
	if (!access || !clmEnabled) {
		throw new Error(
			"Curated handoff needs this session's CLM context (compaction.experimentalClm); use the brief and shared context instead.",
		);
	}
	// Count with the estimator the parent's archive listing and CLM status use: a model-less
	// default Tokenizer falls back to bytes/4, which undercounts dense logs about 2x.
	const tokenizer = access.tokenizer();
	const cap = options.capTokens ?? HANDOFF_SOFT_CAP_TOKENS;
	const full = access.archive();
	const order = new Map(full.items.map((item, index) => [item.id, index]));
	const requested = requestedSelections(access, full, refs, order, tokenizer);
	const excluded = requested.filter(entry => excludeKinds.includes(entry.item.kind)).map(entry => entry.item.id);
	const allowed = requested.filter(entry => !excludeKinds.includes(entry.item.kind));

	const included: Selection[] = [];
	const omitted: Selection[] = [];
	const rendered = new Map<Selection, string>();
	const costs = new Map<Selection, number>();
	const possibleIds = [
		...new Set([...requirementCandidates(full), ...allowed.map(entry => entry.item)].map(item => item.id)),
	];
	const omittedLabel = (ids: readonly string[]) => {
		const shown = ids.slice(0, 12).join(", ");
		return ids.length > 12 ? `${shown} (and ${ids.length - 12} more; list context://parent/archive)` : shown;
	};
	// Reserve the host envelope and bounded omission notice, not only raw item bodies.
	const reserve = prompt.render(handoffSeedTemplate, {
		count: allowed.length + HANDOFF_PIN_MAX_ITEMS,
		tokens: formatTokens(cap),
		independent,
		omitted: omittedLabel(possibleIds),
		cap: formatTokens(cap),
		items: "",
	});
	let used = tokenizer.countMessage({ role: "clmNote", content: reserve, timestamp: 0 });
	const cost = (selection: Selection) => {
		const text = renderSelection(selection);
		rendered.set(selection, text);
		const tokens = tokenizer.countTokens(escapeXmlText(text + "\n\n"));
		costs.set(selection, tokens);
		return tokens;
	};
	if (request?.pinRequirements !== false) {
		const candidates = requirementCandidates(full);
		// At spawn time the parent is mid-turn: its latest user message is the request it is answering.
		const latest = candidates.at(-1);
		let pinned = 0;
		for (const item of candidates) {
			const selection: Selection = {
				item,
				order: order.get(item.id) ?? 0,
				pinned: true,
				trigger: item === latest,
				text: item.text,
				tokens: item.tokens,
			};
			const tokens = cost(selection);
			if (pinned + item.tokens > HANDOFF_PIN_MAX_TOKENS || used + tokens > cap) {
				omitted.push(selection);
				continue;
			}
			pinned += item.tokens;
			used += tokens;
			included.push(selection);
		}
	}
	const pinnedIds = new Set(included.map(entry => entry.item.id));
	for (const selection of allowed) {
		if (pinnedIds.has(selection.item.id)) continue;
		const tokens = cost(selection);
		if (used + tokens > cap) {
			omitted.push(selection);
			continue;
		}
		used += tokens;
		included.push(selection);
		if (!selection.range) {
			for (let index = omitted.length - 1; index >= 0; index--)
				if (omitted[index].item.id === selection.item.id) omitted.splice(index, 1);
		}
	}
	const renderSeed = () => {
		if (included.length === 0 && omitted.length === 0) return undefined;
		return prompt.render(handoffSeedTemplate, {
			count: included.length,
			tokens: formatTokens(included.reduce((sum, entry) => sum + entry.tokens, 0)),
			independent,
			omitted: omittedLabel([...new Set(omitted.map(entry => entry.item.id))]),
			cap: formatTokens(cap),
			items: [...included]
				.sort((a, b) => a.order - b.order || (a.range?.start ?? 0) - (b.range?.start ?? 0))
				.map(entry => rendered.get(entry))
				.join("\n\n"),
		});
	};
	let seed = renderSeed();
	let seedTokens = seed ? tokenizer.countMessage({ role: "clmNote", content: seed, timestamp: 0 }) : 0;
	// Tokenization across boundaries can differ from the sum. Confirm the actual lower-trust envelope fits.
	while (seedTokens > cap && included.length > 0) {
		let excess = seedTokens - cap;
		do {
			const selection = included.pop()!;
			omitted.push(selection);
			excess -= costs.get(selection)!;
		} while (excess > 0 && included.length > 0);
		seed = renderSeed();
		seedTokens = seed ? tokenizer.countMessage({ role: "clmNote", content: seed, timestamp: 0 }) : 0;
	}
	if (seedTokens > cap) {
		seed = undefined;
		seedTokens = 0;
	}
	included.sort((a, b) => a.order - b.order || (a.range?.start ?? 0) - (b.range?.start ?? 0));
	const handed = new Set(included.filter(entry => !entry.range).map(entry => entry.item.id));
	const manifest = renderManifest(excludeArchiveKinds(full, excludeKinds), handed);
	const [includedEntries, omittedEntries] = [included, omitted].map(list =>
		list.map((selection): HandoffEntry => ({
			id: selection.item.id,
			kind: selection.item.kind,
			tokens: selection.tokens,
			pinned: selection.pinned,
			...(selection.range ? { lines: `${selection.range.start}-${selection.range.end}` } : {}),
		})),
	);
	return {
		mode,
		independent,
		seed,
		manifest,
		grant: { access, ownerSessionId: access.ownerSessionId, excludeKinds },
		included: includedEntries,
		omitted: omittedEntries,
		excluded,
		tokens: seedTokens,
		manifestTokens: manifest ? tokenizer.countMessage({ role: "clmNote", content: manifest, timestamp: 0 }) : 0,
		capTokens: cap,
	};
}

/** The per-agent handoff the task card shows; `undefined` when no CLM parent handed anything off. */
export function summarizeTaskHandoff(handoff: ResolvedTaskHandoff | undefined): TaskHandoffSummary | undefined {
	if (!handoff) return undefined;
	switch (handoff.mode) {
		case "brief":
			return { mode: "brief", independent: handoff.independent };
		case "fork":
			return { mode: "fork", tokens: handoff.tokens };
		case "curated":
			return {
				mode: "curated",
				items: handoff.included.length,
				pinned: handoff.included.filter(entry => entry.pinned).length,
				tokens: handoff.tokens,
				manifestTokens: handoff.manifestTokens,
				omitted: handoff.omitted.map(entry => ({
					id: entry.id,
					tokens: entry.tokens,
					...(entry.lines ? { lines: entry.lines } : {}),
				})),
				excluded: handoff.excluded,
				independent: handoff.independent,
			};
	}
}

/** Parent-visible handoff cost for one spawn; `undefined` for a brief spawn (nothing copied). */
export function formatHandoffCost(label: string, handoff: ResolvedTaskHandoff | undefined): string | undefined {
	if (!handoff || handoff.mode === "brief") return undefined;
	if (handoff.mode === "fork") {
		return `Handoff → ${label}: fork of the parent transcript up to its last completed exchange (~${formatTokens(handoff.tokens)} tokens in context; no curated seed).`;
	}
	const pinned = handoff.included.filter(entry => entry.pinned).length;
	const parts = [
		`Handoff → ${label}: ${handoff.included.length} item(s) ~${formatTokens(handoff.tokens)} tokens${pinned > 0 ? ` (${pinned} pinned user message${pinned === 1 ? "" : "s"})` : ""}`,
		handoff.manifest ? `manifest ~${formatTokens(handoff.manifestTokens)} tokens` : "no manifest",
	];
	let line = parts.join(" + ");
	if (handoff.omitted.length > 0) {
		line += `; omitted (over the ${formatTokens(handoff.capTokens)}-token cap or the pinned user-message budget): ${handoff.omitted.map(entry => `${entry.id}${entry.lines ? `:${entry.lines}` : ""} (${formatTokens(entry.tokens)})`).join(", ")} — the child can read them at context://parent/archive/<id>`;
	}
	if (handoff.excluded.length > 0) {
		line += `; withheld from independent reviewer: ${handoff.excluded.join(", ")} (parent reasoning)`;
	}
	return `${line}.`;
}
