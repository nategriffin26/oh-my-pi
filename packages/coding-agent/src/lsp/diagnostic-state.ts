import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, type CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import lateDiagnosticTemplate from "../prompts/tools/lsp-late-diagnostic.md" with { type: "text" };
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { DeferredDiagnosticsEntry } from "../tools";

export const DIAGNOSTIC_STATE = "lsp-diagnostic-state";
interface DiagnosticFile {
	path: string;
	summary: string;
	errored: boolean;
	messages: string[];
}
interface DiagnosticRecord {
	version: 1;
	path: string;
	mutationVersion: number;
	file?: DiagnosticFile;
}
interface DiagnosticDetails {
	version?: 1;
	files: Array<DiagnosticFile & { observationId?: string }>;
}

function record(entry: SessionEntry): DiagnosticRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== DIAGNOSTIC_STATE) return;
	const data = entry.data;
	if (
		!isRecord(data) ||
		data.version !== 1 ||
		typeof data.path !== "string" ||
		!Number.isSafeInteger(data.mutationVersion) ||
		(data.mutationVersion as number) < 1
	)
		return;
	if (
		data.file !== undefined &&
		(!isRecord(data.file) ||
			data.file.path !== data.path ||
			typeof data.file.summary !== "string" ||
			typeof data.file.errored !== "boolean" ||
			!Array.isArray(data.file.messages) ||
			!data.file.messages.every(line => typeof line === "string"))
	)
		return;
	return data as unknown as DiagnosticRecord;
}

/** A history fork cannot undo file mutations observed outside its selected ancestry. */
export function diagnosticInvalidationsForFork(
	entries: readonly SessionEntry[],
	retained: readonly SessionEntry[],
): DiagnosticRecord[] {
	const retainedIds = new Set(retained.map(entry => entry.id));
	const retainedPaths = new Set<string>();
	for (const entry of retained) {
		const data = record(entry);
		if (data) retainedPaths.add(data.path);
	}
	const latest = new Map<string, { id: string; data: DiagnosticRecord }>();
	for (const entry of entries) {
		const data = record(entry);
		if (data && retainedPaths.has(data.path)) latest.set(data.path, { id: entry.id, data });
	}
	return [...latest.values()]
		.filter(entry => !retainedIds.has(entry.id))
		.map(({ data }) => ({
			version: 1,
			path: data.path,
			mutationVersion: data.mutationVersion,
		}));
}

/** Only typed host observations participate; legacy notices remain controls. */
export class DiagnosticLifecycle {
	#sequence = 0;
	readonly #legacyVersions = new Map<string, number>();
	constructor(
		private readonly manager: SessionManager,
		private readonly enabled: () => boolean = () => true,
	) {
		for (const entry of manager.getEntries())
			this.#sequence = Math.max(this.#sequence, record(entry)?.mutationVersion ?? 0);
	}

	version(path: string): number {
		const entries = this.manager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const data = record(entries[i]);
			if (data?.path === path) return data.mutationVersion;
		}
		return this.#legacyVersions.get(path) ?? 0;
	}

	mutate(path: string): number {
		const mutationVersion = (this.#sequence = Math.max(this.#sequence, this.version(path)) + 1);
		if (this.enabled() || this.manager.getEntries().some(entry => record(entry))) {
			this.manager.appendCustomEntry(DIAGNOSTIC_STATE, { version: 1, path, mutationVersion });
		} else this.#legacyVersions.set(path, mutationVersion);
		return mutationVersion;
	}

	report(entry: DeferredDiagnosticsEntry): DeferredDiagnosticsEntry | undefined {
		if (entry.isStale()) return;
		if (entry.mutationVersion === undefined) return entry.suppressed ? undefined : entry;
		if (this.version(entry.path) !== entry.mutationVersion) return;
		const entries = this.manager.getEntries();
		if (!entries.some(item => record(item)?.path === entry.path)) return entry.suppressed ? undefined : entry;
		const snapshot = entry.snapshot ?? entry;
		const file: DiagnosticFile = {
			path: entry.path,
			summary: snapshot.summary,
			errored: snapshot.errored,
			messages: snapshot.messages,
		};
		const previous = entries.findLast(item => record(item)?.path === entry.path);
		if (previous && JSON.stringify(record(previous)?.file) === JSON.stringify(file)) return;
		const observationId = this.manager.appendCustomEntry(DIAGNOSTIC_STATE, {
			version: 1,
			path: entry.path,
			mutationVersion: entry.mutationVersion,
			file: { ...file, messages: [...file.messages] },
		});
		// Clean observations still invalidate old reports, but need no model notification.
		if (file.messages.length === 0) return;
		return {
			...entry,
			...file,
			observationId,
			isStale: () =>
				entry.isStale() ||
				this.manager.getEntries().findLast(item => record(item)?.path === entry.path)?.id !== observationId,
		};
	}
}

export function buildLateDiagnosticsBatchMessage(
	entries: DeferredDiagnosticsEntry[],
): CustomMessage<DiagnosticDetails> | null {
	let batch = entries;
	if (entries.every(entry => entry.observationId)) {
		const latest = new Map<string, DeferredDiagnosticsEntry>();
		for (const entry of entries) latest.set(entry.path, entry);
		batch = [...latest.values()];
	}
	const files = batch.map(entry => ({
		path: entry.path,
		summary: entry.summary,
		errored: entry.errored,
		messages: entry.messages,
		observationId: entry.observationId,
	}));
	return files.length
		? diagnosticMessage({ version: files.every(file => file.observationId) ? 1 : undefined, files }, Date.now())
		: null;
}

function diagnosticMessage(details: DiagnosticDetails, timestamp: number): CustomMessage<DiagnosticDetails> {
	return {
		role: "custom",
		customType: LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
		content: prompt.render(lateDiagnosticTemplate, { multiple: details.files.length > 1, files: details.files }),
		display: true,
		attribution: "agent",
		details,
		timestamp,
	};
}

/** Replay and the CLM transaction owner share the same deterministic host projection. */
export function retireDiagnosticMessages(messages: AgentMessage[], entries: readonly SessionEntry[]): AgentMessage[] {
	const observations = new Map<string, DiagnosticRecord>();
	const latest = new Map<string, string>();
	for (const entry of entries) {
		const data = record(entry);
		if (!data) continue;
		observations.set(entry.id, data);
		latest.set(data.path, entry.id);
	}
	let result: AgentMessage[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		let replacement: AgentMessage | undefined = message;
		if (
			message.role === "custom" &&
			message.customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE &&
			message.attribution === "agent" &&
			isRecord(message.details) &&
			message.details.version === 1 &&
			Object.keys(message.details).length === 2 &&
			Array.isArray(message.details.files) &&
			message.details.files.length > 0
		) {
			const files = message.details.files;
			const authenticated = files.every(file => {
				if (!isRecord(file) || Object.keys(file).length !== 5 || typeof file.observationId !== "string")
					return false;
				const source = observations.get(file.observationId)?.file;
				return (
					source &&
					JSON.stringify({
						path: file.path,
						summary: file.summary,
						errored: file.errored,
						messages: file.messages,
					}) === JSON.stringify(source)
				);
			});
			if (authenticated) {
				const details = message.details as unknown as DiagnosticDetails;
				// A changed body could carry controls; never rewrite it based on a tag alone.
				if (message.content === diagnosticMessage(details, message.timestamp).content) {
					const current = details.files.filter(file => latest.get(file.path) === file.observationId);
					if (current.length !== files.length)
						replacement = current.length
							? diagnosticMessage({ version: 1, files: current }, message.timestamp)
							: undefined;
				}
			}
		}
		if (replacement !== message && !result) result = messages.slice(0, i);
		if (result && replacement) result.push(replacement);
	}
	return result ?? messages;
}
