import { beforeAll, describe, expect, it } from "bun:test";
import {
	ContextInspector,
	type ContextInspectorSearch,
	type ContextInspectorSnapshot,
	type ContextInspectorSource,
} from "../src/overlays/context-inspector";
import { getThemeByName, setThemeInstance } from "../src/theme";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";

const nativeContext = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => false };
const item = (id: string, label: string, timestamp: number) => ({
	id,
	kind: "user",
	label,
	text: label,
	tokens: 5,
	timestamp,
	turn: 1,
	occurrences: 1,
	inContext: false,
});

const snapshot: ContextInspectorSnapshot = {
	revision: "rev2",
	estimatedRequestTokens: 900,
	softLimitTokens: 1000,
	blocks: ["b0", "b1", "b2"].map(id => ({ id, role: "user", tokens: 3, opaque: false, text: `text of ${id}` })),
	revisions: [
		{ id: "rev1", cause: "edit", timestamp: "2026-10-01T13:00:00Z", tokensBefore: 2000, tokensAfter: 1200 },
		{
			id: "rev2",
			previousRevision: "rev1",
			cause: "edit",
			timestamp: "2026-10-01T14:00:00Z",
			tokensBefore: 1200,
			tokensAfter: 900,
		},
	],
	archive: [item("h0000000001", "oldest", 1), item("h0000000002", "middle", 2), item("h0000000003", "newest", 3)],
};

function inspector(search: ContextInspectorSource["search"], isCurrent?: ContextInspectorSource["isCurrent"]) {
	const closed: string[] = [];
	const view = new ContextInspector({
		isCurrent,
		load: () => snapshot,
		diff: revision => ({ before: "rev1", after: revision, changes: [] }),
		search,
		requestRender: () => {},
		close: () => closed.push("closed"),
	});
	return { view, closed };
}

function type(view: ContextInspector, text: string): void {
	for (const ch of text) view.handleInput(ch);
}

function result(query: string, ids: string[]): ContextInspectorSearch {
	return {
		query,
		mode: "lexical",
		fallbackReason: "no judge",
		matches: ids.length,
		hits: ids.map((id, index) => ({
			item: snapshot.archive.find(entry => entry.id === id)!,
			lexicalRank: index + 1,
		})),
	};
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

describe("ContextInspector", () => {
	it("keeps each tab's selection across tab switches and returns key focus to the list", () => {
		const { view } = inspector(async query => result(query, []));
		view.handleInput(DOWN);
		view.handleInput(DOWN);
		expect(view.selectedId).toBe("b2");
		view.handleInput(ENTER);
		expect(view.focus).toBe("detail");

		view.handleInput(TAB);
		expect(view.tab).toBe("history");
		expect(view.focus).toBe("list");
		// History lists the newest revision first.
		expect(view.selectedId).toBe("rev2");
		view.handleInput(DOWN);
		expect(view.selectedId).toBe("rev1");

		view.handleInput(TAB);
		expect(view.tab).toBe("archive");
		expect(view.selectedId).toBe("h0000000003");

		view.handleInput(TAB);
		expect(view.tab).toBe("blocks");
		expect(view.selectedId).toBe("b2");
		view.handleInput(TAB);
		expect(view.selectedId).toBe("rev1");
	});

	it("shows a failed search instead of results, then Esc restores the browsed archive list", async () => {
		const failure = Promise.withResolvers<ContextInspectorSearch>();
		const { view, closed } = inspector(() => failure.promise);
		view.handleInput("\t");
		view.handleInput("\t");
		view.handleInput(DOWN);
		expect(view.selectedId).toBe("h0000000002");

		view.handleInput("/");
		expect(view.focus).toBe("search");
		type(view, "[unclosed");
		view.handleInput(ENTER);
		expect(view.search?.pending).toBe(true);
		failure.reject(new Error("Invalid regular expression"));
		await failure.promise.catch(() => {});
		expect(view.search).toMatchObject({ pending: false, error: "Invalid regular expression" });
		expect(view.selectedId).toBeUndefined();
		const frame = view.render(80).join("\n");
		expect(frame).toContain("Invalid regular expression");

		// The first Esc only clears the search; the browse selection is where it was.
		view.handleInput(ESCAPE);
		expect(view.search).toBeUndefined();
		expect(view.selectedId).toBe("h0000000002");
		expect(closed).toEqual([]);
		view.handleInput(ESCAPE);
		expect(closed).toEqual(["closed"]);
	});

	it("drops a superseded search's late result and aborts a pending search on close", async () => {
		const pending: Array<{ query: string; signal: AbortSignal; done: PromiseWithResolvers<ContextInspectorSearch> }> =
			[];
		const { view } = inspector((query, _regex, signal) => {
			const done = Promise.withResolvers<ContextInspectorSearch>();
			pending.push({ query, signal, done });
			return done.promise;
		});
		view.openSearch();
		type(view, "first");
		view.handleInput(ENTER);
		view.openSearch();
		for (let i = 0; i < 5; i++) view.handleInput("\x7f");
		type(view, "second");
		view.handleInput(ENTER);
		expect(pending.map(entry => entry.query)).toEqual(["first", "second"]);
		expect(pending[0].signal.aborted).toBe(true);

		pending[1].done.resolve(result("second", ["h0000000001"]));
		pending[0].done.resolve(result("first", ["h0000000003", "h0000000002"]));
		await Promise.all([pending[0].done.promise, pending[1].done.promise]);
		expect(view.search?.query).toBe("second");
		expect(view.search?.result?.hits.map(hit => hit.item.id)).toEqual(["h0000000001"]);
		expect(view.selectedId).toBe("h0000000001");

		view.openSearch();
		type(view, "x");
		view.handleInput(ENTER);
		view.handleInput(ESCAPE);
		view.handleInput(ESCAPE);
		expect(pending[2].signal.aborted).toBe(true);
	});
	it("refreshes relevance details when reranking selects the same archive item", async () => {
		let probability = 0.9;
		const { view } = inspector(async query => ({
			...result(query, ["h0000000001"]),
			mode: "jev",
			hits: [{ item: snapshot.archive[0], p: probability }],
		}));
		view.openSearch();
		type(view, "same query");
		view.handleInput(ENTER);
		await Bun.sleep(0);
		expect(view.render(120).join("\n")).toContain("relevance p=0.90");
		view.describe(nativeContext);
		probability = 0.2;
		view.openSearch();
		view.handleInput(ENTER);
		await Bun.sleep(0);
		expect(view.render(120).join("\n")).toContain("relevance p=0.20");
		expect(JSON.stringify(view.describe(nativeContext))).toContain("relevance p=0.20");
	});

	it("aborts a pending search and discards its late result when the source session changes", async () => {
		const pending = Promise.withResolvers<ContextInspectorSearch>();
		let current = true;
		let signal: AbortSignal | undefined;
		const { view, closed } = inspector(
			(_query, _regex, searchSignal) => {
				signal = searchSignal;
				return pending.promise;
			},
			() => current,
		);
		view.openSearch();
		type(view, "old session");
		view.handleInput(ENTER);
		current = false;
		pending.resolve(result("old session", ["h0000000001"]));
		await pending.promise;
		expect(signal?.aborted).toBe(true);
		expect(view.search).toBeUndefined();
		expect(closed).toEqual(["closed"]);
		expect(view.describe(nativeContext).p).toEqual({ hidden: true });
	});
});
