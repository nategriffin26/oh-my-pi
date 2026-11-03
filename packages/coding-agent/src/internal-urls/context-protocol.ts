import contextPrompt from "../prompts/internal-urls/context.md" with { type: "text" };
import { CLM_ARCHIVE_ID_PATTERN } from "../session/clm-archive";
import type { ClmContextAccess, ClmReadTarget } from "../session/clm-types";
import { cfgCompactionClmRecallRerank } from "../session/context-settings";
import type { ToolSession } from "../tools";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	WriteContext,
} from "./types";

const ARCHIVE_MANIFEST_PARAMS: Record<string, true> = { offset: true, limit: true };
const ARCHIVE_SEARCH_PARAMS: Record<string, true> = { q: true, regex: true, limit: true, rerank: true };

function integerParam(params: URLSearchParams, name: string): number | undefined {
	const value = params.get(name);
	if (value === null) return undefined;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
		throw new Error(`Archive parameter ${name} must be a non-negative safe integer`);
	return parsed;
}

function flagParam(params: URLSearchParams, name: string, fallback: boolean): boolean {
	const value = params.get(name);
	if (value === null) return fallback;
	if (value === "1" || value === "true") return true;
	if (value === "0" || value === "false") return false;
	throw new Error(`Archive parameter ${name} must be 1/0 or true/false`);
}

/**
 * Archive routes relative to the URL host: `/archive` (manifest page, `?offset=&limit=`),
 * `/archive?q=` (search, `&regex=1&limit=&rerank=0`), `/archive/<id>` (verbatim item).
 * `undefined` for any other path; the only context routes that accept a query string.
 */
export function archiveTarget(path: string, params: URLSearchParams): ClmReadTarget | undefined {
	const keys = [...params.keys()];
	if (path === "/archive" || path === "/archive/") {
		const query = params.get("q");
		const allowed = query === null ? ARCHIVE_MANIFEST_PARAMS : ARCHIVE_SEARCH_PARAMS;
		const seen = new Set<string>();
		for (const key of keys) {
			if (!Object.hasOwn(allowed, key))
				throw new Error(`Unknown archive parameter ${key}; use ${Object.keys(allowed).join(", ")}`);
			if (seen.has(key)) throw new Error(`Duplicate archive parameter ${key}; supply each parameter once`);
			seen.add(key);
		}
		if (query === null) {
			return { kind: "archive", offset: integerParam(params, "offset"), limit: integerParam(params, "limit") };
		}
		return {
			kind: "archive-search",
			query,
			regex: flagParam(params, "regex", false),
			limit: integerParam(params, "limit"),
			rerank: flagParam(params, "rerank", true),
		};
	}
	if (!path.startsWith("/archive/")) return undefined;
	const id = path.slice("/archive/".length);
	if (!CLM_ARCHIVE_ID_PATTERN.test(id)) throw new Error(`Invalid archive id ${id}; ids look like h0123456789`);
	if (keys.length > 0) throw new Error("Archive item URLs do not accept a query; use :N-M line selectors");
	return { kind: "archive-item", id };
}

function target(url: InternalUrl): ClmReadTarget {
	const path = url.rawPathname ?? url.pathname;
	if (url.username || url.password || url.port) throw new Error("CLM context URLs do not accept credentials or ports");
	const host = url.rawHost.toLowerCase();
	if (host === "parent") throw new Error("context://parent is read-only and serves only /archive routes");
	if (host !== "self") throw new Error("CLM context URL host must be self or parent");
	if (url.hash) throw new Error("CLM context URLs do not accept a fragment");
	const archive = archiveTarget(path, url.searchParams);
	if (archive) return archive;
	if (url.search) throw new Error("Only context://self/archive accepts a query string");
	if (path === "" || path === "/") return { kind: "document" };
	if (path === "/status") return { kind: "status" };
	if (path === "/history") return { kind: "history" };
	const current = /^\/diff\/([A-Za-z0-9_-]+)\/current$/.exec(path);
	if (current) return { kind: "diff", revision: `current:${current[1]}` };
	const match = /^\/(revision|diff)\/([A-Za-z0-9_-]+)$/.exec(path);
	if (match) return { kind: match[1] as "revision" | "diff", revision: match[2] };
	throw new Error("Invalid CLM context path; use /status, /history, /revision/<id>, /diff/<id>, or /archive");
}

function owner(session: ToolSession | undefined): ClmContextAccess {
	const access = session?.clmContext;
	if (!session || !access || !access.isEnabled())
		throw new Error("CLM context document access is unavailable for this session");
	if (
		session.getSessionId?.() !== access.ownerSessionId ||
		session.sessionManager?.getSessionId?.() !== access.ownerSessionId
	) {
		throw new Error("CLM context document belongs to a different session; advisor access is not permitted");
	}
	return access;
}

const PARENT_ARCHIVE_ROUTE = "context://parent/archive";

/**
 * `context://parent/archive*`: read-only, archive routes only, through the grant the spawning
 * parent handed this subagent. No grant (top-level session, advisor, unrelated session) → rejected.
 */
function parentArchiveRead(
	url: InternalUrl,
	session: ToolSession | undefined,
): { access: ClmContextAccess; target: ClmReadTarget } {
	if (url.username || url.password || url.port) throw new Error("CLM context URLs do not accept credentials or ports");
	if (url.hash) throw new Error("CLM context URLs do not accept a fragment");
	const path = url.rawPathname ?? url.pathname;
	const archive = archiveTarget(path, url.searchParams);
	if (!archive || (archive.kind !== "archive" && archive.kind !== "archive-item" && archive.kind !== "archive-search"))
		throw new Error(
			"context://parent serves only /archive, /archive/<id>, and /archive?q=; the parent's document, history, and revisions stay private",
		);
	const grant = session?.parentClmArchive;
	if (!session || !grant)
		throw new Error(
			"No parent archive grant: this session is not a subagent of a CLM session (top-level sessions, advisors, and children of parents without compaction.experimentalClm have no parent archive)",
		);
	if (grant.access.ownerSessionId !== grant.ownerSessionId)
		throw new Error(
			"Parent archive grant expired: the spawning parent switched to another session, whose archive is not shared with this subagent",
		);
	if (!grant.access.isEnabled())
		throw new Error("Parent archive grant expired: the spawning parent's session ended or turned CLM off");
	// Parent access owns the archive and its judge; the reader may still opt out of reranking.
	if (archive.kind === "archive-search" && cfgCompactionClmRecallRerank.get(session.settings) === "lexical")
		archive.rerank = false;
	return {
		access: grant.access,
		target: { ...archive, routePrefix: PARENT_ARCHIVE_ROUTE, excludeKinds: grant.excludeKinds },
	};
}

/** No global owner, backing file, watcher, or generic-edit escape hatch. */
export class ContextProtocolHandler implements ProtocolHandler {
	readonly scheme = "context";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		// This document already lives in memory; raw read–transform–write must not clip its JSON.
		unbounded: true,
		write: {
			via: "handler",
			payload: "verbatim",
			scope: "sandbox",
			tier: (url, _content, session) => {
				try {
					if (target(url).kind !== "document")
						throw new Error("Only context://self accepts whole-document writes");
					owner(session);
					return "write";
				} catch (error) {
					return { tier: "write", policy: "deny", reason: error instanceof Error ? error.message : String(error) };
				}
			},
		},
	};

	promptDoc(host: SchemeHost): string | undefined {
		return host.clmEnabled === true ? contextPrompt.trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const { access, target: readTarget } =
			url.rawHost.toLowerCase() === "parent"
				? parentArchiveRead(url, context?.session)
				: { target: target(url), access: owner(context?.session) };
		context?.signal?.throwIfAborted();
		const { text, details } = await access.read(
			readTarget.kind === "document" && context?.continuesLines
				? { kind: "document", continuation: true }
				: readTarget,
			context?.signal,
		);
		return {
			url: url.rawHref ?? url.href,
			content: text,
			contentType: "text/plain",
			size: Buffer.byteLength(text),
			immutable: true,
			details: { clm: details },
		};
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		if (target(url).kind !== "document") throw new Error("Only context://self accepts whole-document writes");
		const access = owner(context?.session);
		context?.signal?.throwIfAborted();
		const rootCall = context?.toolCall?.context?.toolCall;
		const transactionId = rootCall?.toolCalls[rootCall.index]?.id ?? context?.toolCall?.id ?? crypto.randomUUID();
		const staged = await access.stage(content, transactionId, context?.signal);
		return { content: [{ type: "text", text: JSON.stringify(staged) }] };
	}
}
