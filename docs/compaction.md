# Compaction and Branch Summaries

Compaction and branch summaries are the two mechanisms that keep long sessions usable without losing prior work context.

- **Compaction** rewrites old history into a summary on the current branch.
- **Branch summary** captures abandoned branch context during `/tree` navigation.

Both are persisted as session entries and converted back into user-context messages when rebuilding LLM input. The off-by-default CLM experiment below is an alternative owner of effective context, not another automatic compaction strategy.

## Experimental context document management (CLM)

Enable **Enabled (experimental)** in `/settings` → Context → **Context document**, or use a launch overlay with `omp --config <file>`. That group also holds the CLM-only rows (soft limit, recall rerank, handoff default, context-edit display); they stay listed but dim while CLM is off. The soft limit is the Compaction group's threshold: its row shows the setting in force (`= Compaction Token Limit (…)` when a token limit is set, else `= Compaction Threshold (…)`) and Enter edits that setting.

```yaml
compaction:
   experimentalClm: true
   experimentalContextManagement: false
```

The two experimental modes are mutually exclusive. Conflicting configuration refuses CLM writes and provider dispatch; omp does not silently change either setting. CLM owns automatic history management: routine compaction, pruning, shaking, notes rollover, overflow fallback, and already-armed speculative compaction cannot independently rewrite its context. Turning CLM off disables future edits, not replay of accepted revisions.

Enabled CLM adds a dedicated model-facing system-prompt block, including with custom prompt templates. It assigns context maintenance to the model rather than waiting for automatic compaction: inspect capacity before large observations, respond to pressure, preserve exact task facts and execution evidence, remove obsolete material selectively, and verify durable acceptance of each edit. Working notes distinguish explicit requirements and their sources, verified observations and their evidence, and assumptions or open questions; an earlier policy guess is not a requirement. It also explains why eval-state persistence does not imply automatic compaction. Changing the CLM setting refreshes this guidance in a running session. These instructions guide decisions; they do not guarantee lossless semantic summaries or task-quality improvements.

### Document and transaction

The model reads `context://self:raw` and writes the complete JSON document to `context://self` through the normal tools. The versioned envelope binds the snapshot to its owning session, branch, model, and revision. Keep its envelope and host-issued block metadata unchanged. Completed exchanges can be deleted, reordered within protected boundaries, rewritten, or supplemented with `{ "text": "working state" }` blocks. The current human request, developer messages (including host custom/hook controls), and live exchange are protected. Native tool groups remain atomic; unchanged blocks preserve native payloads and object identity. New notes placed after an incomplete live exchange are moved just before it so pending results stay adjacent. Opaque/image blocks must stay unchanged or be deleted as whole editable blocks.

Changed text becomes lower-trust `clmNote` context, never a new developer instruction, human request, signed assistant message, or executed tool call. A copied header or role label cannot create authority. The capability cannot address a parent, peer, or advisor session. Generic `edit`, `ast_edit`, and filesystem writes do not implement this virtual resource.

A write returns **staged**, not accepted. After all sibling tool results settle and persist, the host revalidates the draft and request budget, atomically persists a `context_projection` checkpoint, then publishes the effective messages to both the session and running loop. A healthy terminal yield can commit without starting another model request. Aborted/error turns discard uncommitted drafts. Cancellation after durable commit does not undo the revision, and tools are never rerun to repair context.

In code mode, read–transform–write can happen in one cell without printing the old document. For a complete `:raw` read, the JavaScript and Python session-tool bridges return the full captured snapshot in the result's `text` field (or as text), even when the human-visible result spills to an artifact. Parse that value directly; no artifact pagination or display-footer parsing is needed inside eval. Explicitly paged or incomplete reads remain partial. Direct tool reads outside eval still have bounded previews: if they spill, recover the same stable artifact or its advertised backing file rather than concatenating fresh live reads. Never print the full document to transfer it between tools: doing so adds the history back as a new tool observation. Filesystem access to a recovery artifact is not a context commit route.

### Inspection and recovery

- `/context` in the interactive TUI with CLM enabled opens the read-only context inspector, a fullscreen frame like `/settings` titled **Context**. The header line shows the active revision, block count, request estimate, percent of the soft limit, and archive size. Three tabs (`Tab`/`Shift+Tab`) each list entries beside the selected entry's detail; below 100 columns the detail drops under the list. **Blocks** lists the effective document's blocks (id, role, token count, protected/note/opaque flag) with the full block text as detail. **History** lists branch-visible revisions newest first (cause, tokens before → after, delta) with the blocks each one removed and added relative to its predecessor; `d` on the Blocks tab jumps here. **Archive** lists archive items newest first with the verbatim item as detail; `/` (from any tab) opens a search that ranks exactly like `context://self/archive?q=`: Jev rerank when a native judge is configured and `compaction.clmRecallRerank` is `jev`, otherwise lexical with the reason shown. `Ctrl+R` in the search field toggles a regex filter. `Enter` focuses the detail pane for scrolling. `Esc` clears an archive search, then closes. Selection is kept per tab. The inspector never edits context. With CLM disabled, and outside the interactive TUI, `/context` prints the status JSON followed by the Context Usage view.
- `/context status`: active revision, staged transaction, request estimate, local/calibrated estimates (`localExact` says whether the local count is exact), provider-usage anchor validity, soft limit, hard capacity, reply reserve/safety margin, remaining tokens, historical observed usage, and latest receipt. A calibrated estimate is not a measurement of the entire next request.
- `/context show`: effective context document, distinct from the original execution transcript.
- `/context history` and `/context diff <revision>`: branch-visible revisions and changed content.
- `/context restore <revision|previous>`: create a new durable revision while retaining current human/developer constraints; requires an idle session and CLM enabled. It does not delete history.
- Model inspection routes: `context://self/status`, `/history`, `/revision/<id>` and `/diff/<id>` (what that revision changed versus its predecessor), `/diff/<id>/current` (that revision versus current context). `previous` names the revision before the current one; with a single revision it is the pre-projection root. Only the root is writable.
- In the interactive transcript, `read context://…` results render from structured read details rather than the model's text (which is unchanged): the document and its line-range pages as a block table (count, tokens, percent of soft limit, revision and snapshot; then id, role, tokens, protected/opaque flags, preview), `/status` as fields under a soft-limit gauge in the status-line meter's style, `/history` newest first, diffs as a diff cell, the archive listing as an item table, `/archive/<id>` as a numbered recall cell, and `/archive?q=` (self or parent) as hits ranked best first with a 10-cell relevance bar and probability (lexical rank alone when ranking stayed lexical; no bar for regex) plus a footer with shortlist/scan counts and judge requests, tokens, cost, and time or the lexical-fallback reason. Collapsed views show five rows; ctrl+o expands. Details persist with the tool result, so resumed sessions render the same.
- RPC: `get_clm_context` and `restore_clm_context`; SDK: `session.getClmContext()` and `session.restoreClmContext(revision)`, plus `session.getClmInspector()` for the inspector's structured, read-only views (`inspect()`, `revisionDiff(revision)`, `searchArchive(query, regex, signal)`). TUI, ACP, and RPC slash-command handlers expose the same inspection operations.

**Archive and recall.** `context://self/archive` is a read-only archive of model-readable message text on the active branch after its last reset, built on demand from the append-only journal (`src/session/clm-archive.ts`). Items are sub-exchange units: one user/assistant/custom message, model note (from `context_projection` entries), summary, or tool call paired with its own result (`task` results are `subagent` items); pending calls are listed only once a result exists. Tool items render compact one-line JSON args, except multi-line string args (write content, edit bodies, long commands), which follow as verbatim `field: <<EOF … EOF` blocks so `:N-M` selectors and `L<n>` excerpts address real lines. Ids are `h` + 10 hex chars of a content hash over the one-line identity form (not the display rendering) and remain stable across edits, revisions, resumes, and processes. Repeated content shares an item (`seen ×N`, `lastSeen`), while turn numbers count actual user occurrences, including identical prompts. Deleted content remains recoverable; `in-context` marks current membership. `superseded-by <id>` marks a later successful mutation of an item’s file after its latest observed occurrence: write/edit tools, using tool-recorded absolute paths where available so cwd changes and suffix resolution do not misidentify files, and conservatively parsed shell commands (`src/session/clm-archive-shell.ts`: `sed -i`/`perl -i`, `tee [-a]`, `>`/`>>`/`&>` redirect targets, `mv`/`cp` destinations, `git checkout|restore -- <paths>`, and `git apply`/`patch` with an inline heredoc diff), resolved against the call’s cwd and literal `cd`s. Non-literal words (variables, globs, substitutions), `/dev/*`, and internal URLs are ignored. A later successful run of the same whitespace-normalized shell command in the same directory supersedes an earlier run with different output, and a later read of the same path and selector with different content supersedes the earlier read; the nearest later change wins. Failed mutations, failed reruns, and failed reads (error results, non-zero exits, cancelled runs) supersede nothing, so a refused rerun of a one-time script never hides its original output; other external filesystem or repository changes are not tracked. Newly persisted message entries retain hashes of oversized original strings so different tails never deduplicate merely because persistence kept the same prefix. Full live/projection copies replace their own truncated survivors without changing ids; older lossy entries without hashes use occurrence-scoped identities and carry `truncated` when only the damaged copy survives.

Each committed CLM revision regenerates one editable, host-authored out-of-context archive index at the document end, bounded to 1,000 estimated tokens including the XML-escaped historical-data wrapper and a `+N more items — search context://self/archive?q=` hint. Lines list id, kind, token size, and label, ordered by how hard the item is to recover, newest first within a tier: user messages, notes, and summaries; then unreproducible output (shell runs including non-zero exits, web fetches, subagent results, superseded or URL reads); then assistant text; then reads and searches of files a rerun reproduces. Reproducible items of one tool and directory collapse into one line (`12× read logs/shard-*.log 46.6ktok (h…, h…, … +N)`) with as many ids as fit; failed non-shell calls collapse into one `N failed tool calls` line unless a call is the only trace of its turn. Each user turn that lost items keeps its best line first while one fits, and labels drop the session cwd prefix. No missing items means no index. It lowers as user-role data, never developer authority, and is excluded from the archive to avoid recursive search pollution. Deleting it is allowed; the next commit restores it. Before denying an earlier action or repeating a tool, search the archive; cite stable archive ids in notes when deleting evidence.

Routes: `/archive` (chronological manifest, `?offset=&limit=`, default 200 per page), `/archive/<id>` (verbatim item text; read-tool line selectors apply), `/archive?q=<terms>` (search; `&regex=1`, `&limit=` up to 50, `&rerank=0`). Only archive routes accept queries; duplicate/unknown parameters and unsafe integer values are rejected. Search tokenizes identifiers and paths plus camelCase/separator parts, normalizes Unicode to NFC, and includes CJK character/pair terms. A 64-item BM25 shortlist, plus any items that supersede shortlisted ones, is reranked by the native judge (TypeSafe Jev, `purpose: recall`, journaled as model usage), with one noul question per item over bounded, evidence-focused passages. Passages of superseded items carry `[superseded by h… at <time>]`, and the question tells the judge the searcher wants the current state unless the search asks about history. Concurrently with that rerank, a label scan judges compact views (manifest line plus the first three content lines) of every other item newest first, 256 per request within a 100k-token budget, so evidence phrased differently from the search is judged even when a lexical distractor looks relevant; views at p ≥ 0.2 (best 16) are reranked on full passages. Packing includes serialized state and each branch’s question within a 24k-token budget. Items at p ≥ 0.2 are kept; relevance selects hits, which are displayed chronologically and tagged `lexical #N`, `label scan`, or `supersedes a match`. Excerpt lines favor query terms that are rare within the item (a term on every table row says little); when an excerpt omits or clips a line, the hit says `excerpt: k of N lines — read …/<id> before answering exact questions`. In every ordering a superseded item never ranks above a kept item that superseded it. The header reports requests, tokens, cost, and time; backends that bill nothing are priced from the judge model’s catalog input rate. Missing judges, errors, oversized queries, and the 20-second rerank deadline fail open to complete lexical evidence, with the reason in the header; caller cancellation propagates instead. If the judge finds no relevant item, lexical hits remain explicitly marked weak evidence. `regex=1` is a case-insensitive exact filter, never reranked, with a bounded execution deadline; invalid or timed-out patterns fail rather than report incomplete matches. Expansion retains verbatim spelling and line numbers despite normalized search. `rankClmArchive` (`src/session/clm-archive-search.ts`) returns the same ranking as data (mode, fallback reason, candidates with lexical rank and origin, hits with p, judge usage); `searchClmArchive` renders it.
The best-ranked hit is shown whole, with every line numbered, when it is at most 1,500 tokens. In live runs, weaker models answered table questions from a partial excerpt instead of expanding the item.
`compaction.clmRecallRerank: lexical` keeps every search (self and parent archive) in BM25 order without resolving or calling the judge, even when one is configured; the header's lexical-fallback reason names the setting.

Recall follows supersession chains to the current replacement without adding every intermediate to the shortlist. The label-scan budget counts each serialized request state (including the search and criteria), every question, and a 512-token per-request framing reserve; it does not include the initial shortlist rerank or the full-passage rerank of scan finds. When the newest-first scan reaches its budget, the header reports the covered/eligible counts and truncation; `rankClmArchive` exposes them as `scanned` and `scanTotal`. Each search has at most four judge requests in flight across its concurrent rerank and scan, and searches sharing a judge space request starts at least 25 ms apart. Failure aborts queued requests and retains completed usage in the lexical fallback, including when there are no lexical matches. Heredoc delimiters avoid both LF and CRLF body lines, and non-identifier argument keys use JSON-quoted bracket paths to distinguish literal keys from nested fields.

Supersession markers describe a complete replacement: every touched path must lead to the same later mutation. Partial or split replacements of multi-path items, and copy/move destinations whose historical file type is ambiguous, remain unmarked rather than making current evidence appear stale.

**Subagent handoff.** Under CLM, `task` items take `handoff` refs (`h<id>` archive ids, or `b<N>` blocks of a still-valid parent snapshot, optional `:N-M`), `handoffMode` (`curated` default, `brief`, `fork`), and `pinRequirements` (default true). The host resolves refs at spawn (`src/task/handoff.ts`) and persists one editable `clm-handoff` seed in the child journal: pinned user requirements plus requested items, verbatim and chronological, with provenance. Seed and manifest lower as XML-escaped user-role historical data inside `<clm-note>`, never developer instructions. The rendered seed, including provenance, escaped text and wrapper, is capped at 24k estimated tokens; oversized items are omitted, with a bounded omission notice and full parent-visible cost report. A separate protected `clm-parent-manifest` message lists up to 60 other parent items. `context://parent/archive*` is read-only and bound to the spawning parent identity; it fails after parent disposal, CLM disablement, or a session switch. Independent reviewers receive no parent assistant text, notes (including prior handoff seeds), or summaries through seed, manifest, item reads or search. Agent frontmatter overrides role-token/camel-case name inference. `brief` keeps assignment and shared context without handoff; CLM-only `fork` inherits the effective parent journal, resets the child todo list and costs, and is refused for independent reviewers and in-memory parents.

Handoff budgets count with the parent CLM context's tokenizer (`ClmContextAccess.tokenizer()`), so the spawn line, cap, and pin budget agree with `context://self/archive` sizes. Pins are labelled as user→parent messages, the latest as the request the parent was delegating from. A CLM parent's `brief` (and eval-spawned) children get only the read-only `context://parent/archive` grant plus a one-line pointer. `fork` drops the parent's in-flight assistant turn (the one holding the `task` call) so the child's transcript ends at the last completed exchange, followed by a role-switch notice and the assignment.
Fork cutoff resolves only results following the candidate assistant (tool ids reused by older exchanges do not count), respects completed CLM projection coverage and reset boundaries, and removes descendant metadata with the in-flight exchange. When retained sibling history follows the selected cutoff in journal order, an empty branch marker persists the active leaf so reopening the child replays the same completed branch.
Parent archive grants are bound to the immediate spawning CLM session and the original child conversation. SDK top-level sessions and advisors cannot use them; starting or switching to another conversation in the child runtime removes access. A non-CLM immediate parent does not forward its own ancestor grant. Reviewer exclusions apply equally to brief task and eval children, including manifest, search, and direct item reads.
`compaction.clmHandoffDefault` (`curated` default, `brief`, `fork`) sets the mode of a CLM parent's spawn that names neither `handoffMode` nor refs; the task tool description states the configured default. A defaulted `fork` that cannot happen (independent reviewer, in-memory parent) becomes `curated` instead of failing the spawn. Each task item resolves its own handoff, so one call can hand different context to different agents. The task card shows each agent's handoff on one dim `➦` line under its row (from `handoff` on the agent's progress/result details, so reloads render the same): curated item count, seed tokens, manifest tokens, pinned count, and the ids and sizes of items the cap omitted (warning color); `brief` with parent-archive access (noting withheld reasoning for reviewers); `fork` with the inherited transcript tokens. Collapsed it is one truncated row; ⌃O wraps it in full.

Resume and forks replay the visible checkpoint plus later branch messages. Reset hides prior revisions from effective context. The original journal remains available for forensic inspection; branch summaries, handoff inputs, and advisor context consume effective history instead. New readers reject unsupported/corrupt projections and missing checkpoint content rather than falling back to discarded raw history.

**Capacity.** Under CLM the compaction settings are never a hard limit. The configured compaction threshold (`compaction.thresholdTokens`/`thresholdPercent`/`reserveTokens`, reported as `softLimitTokens`) is a **soft line**: approaching it (one batch-sized step early, at least 20% of the window) sends a one-time `CLM pressure` notice; past it every new revision or prompt receives a `CLM urgent` notice asking the model to do context work now. Neither blocks dispatch. The only hard line is the real window minus the reply reserve (`capacityTokens`; reserve = the request's output cap, else the model's `maxTokens`, at most half the window). When the full reply no longer fits, the request is sent with a reduced output cap (never below `min(reserve, 4096)`) plus an urgent notice. If even that does not fit, tool results the model has not yet seen are moved to artifacts (newest first, preview kept, `spill` revision) without rerunning tools. Only then does the request fail with a non-retriable `CLM request does not fit the context window` error instead of silently dropping input. `/compact` is an explicit readable rescue over effective context and creates another projection; legacy destructive paths such as shake, image dropping, native remote compaction, and snapcompact refuse while a projection is authoritative. Opaque whole-history native compaction capsules cannot activate CLM: use a readable session. Per-message native reasoning that remains replay-safe is preserved.

**Host feedback.** Pressure/urgent notices and commit/rejection receipts are host notices (`clm-feedback` custom messages rendered as `<system-notice source="clm">`), not model-authored `<clm-note>` text. They are queued per owner and prompt generation, attached to the next request that is sent anyway (including the first request of a new prompt, and the request that crossed a line), journaled, and never create autonomous continuation turns. The model may delete stale notices like any editable block.

Budget status exposes `localRequestTokens`, `calibratedRequestTokens` (null without a valid anchor), `ratioAdjustedRequestTokens`, and `estimatedRequestTokens` (the largest). A usable provider response with input plus cache-read/write anchors the dispatched prefix, excluding generated output (`usageAnchor.source: "prompt"`, `promptTokens`). When the provider reports `usage.contextTokens`, CLM instead anchors conversation occupancy after the completed assistant response (`source: "occupancy"`, `occupancyTokens`), not an exact dispatched-prompt measurement. It adds only locally estimated messages appended after that checkpoint and framing growth, never the completed response twice. Session/revision changes, rewritten prefixes, model or endpoint changes, changed tool schemas or non-append-only system context invalidate exact reuse; for a rewrite on the same provider, model, and conversation, the last measured/local ratio (clamped to 1–4×) charges added local tokens, but deletions credit only their local size so they cannot erase additive provider overhead. Models without an exact catalog tokenizer are counted with o200k rather than a byte heuristic; the safety margin applies only to the unmeasured part, at 10% for exact counts and 25% otherwise. The dispatch gate also checks the prepared provider prefix. Arbitrary provider-payload hooks disable calibration because their final request cannot be certified. `usageAnchor` reports validity, reason, source (`prompt` or `occupancy`), the corresponding measured token count, provider, model, and timestamp. `lastObservedUsage` remains historical only; resume and rewritten candidates do not borrow old assistant usage as a new anchor.

CLM also retires superseded **host-authenticated, data-only late LSP diagnostics**. Instrumented file mutations and newer reports (including clean reports) invalidate earlier observations for that file; a multi-file notice retains its still-current portions. The host commits retirement as a `diagnostics` revision before dispatch, without publishing queued user input early, or after persisting completed turn outcomes. Original observations remain in the forensic journal. Current reports, unknown/legacy or modified notices, and actual developer/user controls remain protected; the model cannot use retirement to edit them. Tracking follows observed tool mutations, not arbitrary external filesystem changes. History navigation cannot undo a recorded file mutation; forks carry invalidations for retained superseded reports. The lifecycle starts only with CLM or an existing projection, but already-managed observations remain managed after CLM is disabled.

If checkpoint persistence rolls back successfully, the previous effective revision remains authoritative. Indeterminate persistence or post-durable publication failure stops further requests: restart omp and reopen the journal before continuing. These are software-crash guarantees, not an additional power-loss/fsync guarantee.

**Compatibility:** journals advertise `requiredFeatures.contextProjection = 1` for projections and `requiredFeatures.managedDiagnostics = 1` for managed diagnostic provenance, even before its first projection. A projection carrying a string longer than the 500k-character per-string persistence cap stores it losslessly in the blob store and adds `requiredFeatures.contextProjectionStrings = 1`, so readers that cannot rehydrate it refuse instead of replaying an empty string. Readers reject unsupported features. Opening these journals in pre-feature binaries is unsupported: old binaries may ignore new entries, and a session-version number alone does not make downgrade safe. Keep private resumable journals separate from sanitized display/share exports. CLM remains experimental: successful mechanics do not establish workload-quality, cost, or speed improvements.

## Key implementation files

- `packages/agent/src/compaction/compaction.ts` (context-full summarization and handoff generation)
- `packages/snapcompact/src/snapcompact.ts` (snapcompact strategy: history archived as dense bitmap images)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts` (provider-native streaming compaction)
- `packages/agent/src/compaction/shake.ts` (mechanical content elision)
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/agent/src/compaction/messages.ts` (shared LLM conversion and summary wrappers)
- `packages/coding-agent/src/session/session-context.ts` (context and transcript assembly)
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts` (automatic maintenance orchestration)
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/session/context-settings.ts` (`compaction.*`, `snapcompact.*`, `branchSummary.*` definitions)

## Session entry model

Compaction and branch summaries are first-class session entries, not plain assistant/user messages.

- `CompactionEntry`
   - `type: "compaction"`
   - `summary`, optional `shortSummary`
   - `firstKeptEntryId` (compaction boundary)
   - `tokensBefore`
   - optional `details`, `preserveData`, `fromExtension`
   - optional `method`, `tokensAfter`, `warning` (maintenance/display metadata)
   - optional `providerReplayThroughEntryId` (last entry covered by a native replay snapshot)
- `BranchSummaryEntry`
   - `type: "branch_summary"`
   - `fromId`, `summary`
   - optional `details`, `fromExtension`

When context is rebuilt (`buildSessionContext`):

1. Latest compaction on the active path is converted to one `compactionSummary` message.
2. Kept entries from `firstKeptEntryId` to the compaction point are re-included.
3. Later entries on the path are appended.
4. `branch_summary` entries are converted to `branchSummary` messages.
5. `custom_message` entries are converted to `custom` messages.

Those custom roles are then transformed into LLM-facing messages in `convertToLlm()`: `compactionSummary` and `branchSummary` become user messages rendered through the static templates

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`
- `packages/agent/src/compaction/prompts/handoff-summary-context.md` (when `method === "handoff"`)

Snapcompact summaries with ordered archive blocks bypass these wrappers and send the lead-in plus archive blocks directly. `custom` messages normally pass through as developer messages with their raw content (no summary template).

Native replay also requires a matching provider and a Responses-family API on the active model. A separate native compaction endpoint does not give a Chat Completions or Anthropic encoder the ability to consume its output.

Disabling future native compaction does not disable normal replay of an existing payload. Compaction preparation has a separate, stricter reuse policy: local summarization must re-expand the original messages rather than treat an opaque placeholder as a readable summary.

## Compaction pipeline

### Triggers

Compaction/context maintenance can run in six ways:

1. **Manual context compaction**: `/compact [instructions]` calls `AgentSession.compact(...)`.
2. **Automatic overflow recovery**: after a same-model assistant error that matches context overflow.
3. **Automatic incomplete-output recovery**: after a same-model assistant message ends with `stopReason === "length"` (including OpenAI/Codex `response.incomplete` and Anthropic output/context limits), subject to the output-cap checks below.
4. **Automatic threshold maintenance**: after a successful turn when context exceeds the resolved threshold.
5. **Mid-turn threshold maintenance**: before the next provider request when a tool-loop turn crosses the threshold and `compaction.midTurnEnabled !== false`. Subagent sessions always run this check: `createSubagentSettings` pins `compaction.midTurnEnabled` on for the child because a whole assignment is one turn, so post-turn maintenance would only fire after the run already ended.
6. **Idle maintenance**: `runIdleCompaction()` can invoke the same auto-maintenance path with reason `"idle"`.

### Compaction shape (visual)

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### Overflow/incomplete recovery vs threshold/idle maintenance

The automatic paths are intentionally different:

- **Overflow recovery**
   - Trigger: current-model assistant error is detected as context overflow and the error is not older than the latest compaction.
   - The failing assistant error message is removed from active agent state before retry.
   - Context promotion is tried first; if a configured larger model is available, the agent switches model and retries without compacting.
   - If promotion is unavailable and compaction is enabled, automatic maintenance walks `compaction.methodOrder` with `reason: "overflow"` and `willRetry: true`; handoff is skipped because its request would reuse the overflowing input.
   - On success, `agent.continue()` is scheduled to retry the turn.

- **Incomplete-output recovery**
   - Trigger: same-model assistant message ends with `stopReason === "length"` and the message is not older than the latest compaction.
   - When the window is below the compaction threshold and the turn delivered text or a tool call, the truncated turn is retained and an output-limit warning is shown; compaction cannot raise the output cap.
   - Otherwise the incomplete assistant is removed from active state, and context promotion is tried first.
   - With maintenance enabled, no-output turns below threshold retry without compaction; a reasoning-only output-cap stop also receives a developer reminder to act in smaller steps.
   - Above threshold (or with an unknown window), auto maintenance walks `compaction.methodOrder` with `reason: "incomplete"` and `willRetry: true`. Unlike overflow, a reachable `handoff` may run because the input remains usable.
   - Consecutive recoveries without text or a tool call are capped at three; new user input or actionable output resets the counter. The terminal cap blocks automatic continuation and reports an actionable failure.
   - Successful recovery schedules continuation.

- **Threshold maintenance**
   - Trigger: successful, non-error assistant message whose adjusted context tokens exceed `resolveThresholdTokens(...)`. The measured count comes from `calculateContextTokens(...)`, which subtracts provider-side orchestration tokens (billable, but never replayed into the conversation prefix) so auto-compaction and context-promotion thresholds are not inflated by them.
   - Mid-turn maintenance also checks safe tool-loop boundaries before the next provider request when `compaction.midTurnEnabled !== false`.
   - The initial trigger uses adjusted provider usage floored by the stored-conversation estimate; pruning does not retroactively reduce the just-billed prompt. Reclaimed tokens affect the subsequent maintenance target. Usage predating the latest compaction is ignored in favor of the live stored estimate.
   - Context promotion is tried before post-turn compaction.
   - If promotion is unavailable, auto maintenance walks `compaction.methodOrder` with `reason: "threshold"` and `willRetry: false`.
   - When `handoff` is the next runnable method, post-turn threshold maintenance normally schedules a post-prompt task that generates the handoff document and commits it as a compaction entry; pre-prompt and mid-turn checks run all methods inline to avoid racing the next turn.
   - On success, if `compaction.autoContinue !== false`, post-turn maintenance schedules an agent-authored developer auto-continue prompt from `prompts/system/auto-continue.md`; mid-turn maintenance never schedules a separate continuation because the core loop already owns the next provider request.

- **Idle maintenance**
   - Trigger: `runIdleCompaction()` when not streaming or already compacting.
   - Uses `reason: "idle"` and does not auto-continue afterward.

### Payload-rejection guard

HTTP 413 / payload rejections are not automatically treated as token overflow. A known window with at least 10% locally estimated headroom and provider input usage within that window, or explicit image-limit evidence without usage-backed overflow, blocks automatic continuation and emits a payload-budget warning rather than promoting or compacting.

When provider usage proves token overflow, maintenance can still shrink context. Snapcompact is excluded for byte/media-shaped rejections unless usage proves a token overflow without explicit media-limit evidence. With an unknown window, maintenance may attempt a runnable overflow method; an unavailable or no-progress recovery blocks automatic continuation rather than resubmitting unchanged history.

### Experimental notes-backed context windows

Enable **Notes-backed context windows (experimental)** in `/settings`; the running session gains the tools immediately. The equivalent configuration is:

```yaml
compaction:
   experimentalContextManagement: true
```

This opt-in mode replaces automatic summary recompression with local context-window
boundaries. It also applies to `/compact` without an explicit mode or focus text.
Explicit compaction modes and focused instructions retain their existing behavior.

- `context_notes` reads the current notebook when `text` is omitted, replaces it
  when `text` is supplied, and clears it with `text: ""`.
- Notebook revisions are journal entries on the active branch. Only the latest
  visible revision is injected into model context, including after resume or fork.
  A context reset clears the visible notebook. Each replacement is limited to
  **16,384 UTF-8 bytes**; oversized writes fail without replacing the notes.
- `new_context` requests rollover at the next safe tool-loop boundary. Rollover
  retains complete recent tool-call/result units and the notebook without calling
  a summarization model. Near the automatic threshold, the model receives a
  once-per-window reminder to save its working state.
- `read` and `grep` can recover original messages and tool outputs through
  `history://current/full`. The text includes stable entry IDs and window
  boundaries. Shared selectors work, for example
  `history://current/full:1-200` and `history://current/full:raw:1-200`.
  Queries, fragments, trailing slashes, and additional path components are rejected.
- The full-history route is bound to the calling session's current branch. It
  never falls back to another registered agent or an on-disk session search.
  Existing `history://<id>` routes retain their concise transcript behavior.

Experimental rollover requires the effective tool set to contain `context_notes`,
`new_context`, `read`, and `grep`. Restricted sessions without all four retain
legacy maintenance. Disabling the setting restores legacy compaction and disables
the experimental tools and full-history route; existing notes remain in the journal
and provider context.

The default is `false`. This is an independent implementation of persistent notes
and searchable history, with the existing session journal as its only transcript
store.[^experimental-context-history]

[^experimental-context-history]:
    Earlier pruning or explicit destructive history
    operations cannot be undone by enabling the setting. Text history represents
    images as markers. Notebook quality and timely updates remain the model's
    responsibility; the mode does not automatically generate missing notes.

### Shake method

Including `shake` in `compaction.methodOrder` performs an inline, local reduction instead of calling a summarization model. It replaces eligible tool results and large fenced/XML blocks with recoverable `artifact://` references, using a protected recent-token window and minimum-savings threshold. Automatic shake emits the normal auto-compaction events with `action: "shake"`.

Threshold, incomplete-output, and overflow recovery advance to the next configured method when shake cannot reclaim enough context to get below the recovery band; this prevents repeated no-op shake loops. Idle shake does not use that fallback because the idle timer rechecks usage before running again. Manual `/shake` is a separate, more aggressive command that can target all eligible history.

### Snapcompact method

Including `snapcompact` in `compaction.methodOrder` replaces the LLM summarization call with a local, deterministic archival pass (`compact` from `@oh-my-pi/snapcompact`):

- The discarded history is serialized, whitespace-collapsed, and printed onto model-aware PNG frames (frame width fixed per shape; frame height hugs the rows actually printed) using bundled public-domain pixel fonts. The shape — and frame size — resolve from the **model id** when the model line was measured: Claude reads X.org `8x13` glyphs on an 11px advance (extra letter-spacing, black ink — `11on16-bw`; high-res lines — Opus 4.7+, Fable, Mythos — get 1932px frames under Anthropic's 4,784 visual-token cap, older lines stay at 1568px), Gemini reads `8x13` glyphs on a 22px pitch (extra leading, black ink — `8on22-bw` at 2048px, since Gemini 3.x bills a fixed 1,120-token budget per image at any pixel size), GPT/Codex read the same `8on22-bw` shape at 1568px (patch billing is area-proportional, so larger frames cannot improve chars per token), and Kimi/GLM read `8x13` glyphs on a 16px pitch (`8on16-bw` at 1568px — kimi's processor downscales past 1792px). A Claude routed through Vertex or OpenRouter keeps its Claude shape. Auto selection is also font-aware (`resolveShapeForText`): when the model-default font cannot safely render the transcript, or wide CJK glyphs dominate it and the `silver16-bw` grid can render it safely, auto switches to `silver16-bw`; forced variants are never overridden. Unmeasured models fall back to their wire API family (Anthropic-family/unknown → `11on16-bw`, Google → `8on22-bw`, OpenAI-compatible → `8on22-bw`); billing (per-family patch/budget formulas, OpenAI's `detail: "original"` hint) always follows the API carrying the request, computed for the resolved frame size. The `snapcompact.shape` setting (default `auto`) forces one of the research-eval variants instead: square grids (`8x8r`/`8x8u`/`6x6u`/`5x8` × sentence-hue/black ink) or the per-model eval winners (`6x12-dim`, `8x13-bw`, `8on16-bw`, `8on22-bw`, `11on16-bw`, `silver16-bw` — the embedded Silver TrueType font on a 16px grid for CJK and other non-Latin text — and the two-column word-wrapped `doc-8on16-bw`/`-sent`/`-sent-dim`, where `dim` prints stopwords in gray). A forced variant keeps its geometry but is re-priced for the target provider's image billing. The same setting governs inline system-prompt/tool-result imaging (`snapcompact.systemPrompt`, `snapcompact.toolResults`).
- Serialization keeps the archive conversation-dense: tool results are truncated head+tail (default 2,000 chars at a 0.6 head ratio), tool-call argument values are capped per value (500) and per call (2,000), and tool output is printed in dim gray ink so conversation reads louder than tool noise. All budgets and the dimming are configurable via `SerializeOptions` (`toolResultMaxChars`, `toolArgMaxChars`, `toolCallMaxChars`, `truncateHeadRatio`, `dimToolResults`).
- The snapcompact archive persists under `CompactionEntry.preserveData.snapcompact` as bounded source text plus rendered frames. On each context rebuild it is reconstructed into ordered compaction blocks: plain text at the oldest edge, an imaged middle, then plain text at the newest edge. The entry's `summary` is just the short resume lead-in plus the usual file-operation list.
- Later compactions re-render from that bounded source text (`Archive.text`), not by carrying old PNGs forward blindly. `maxFrames` now defaults to `MAX_FRAMES_DEFAULT` (80) and acts only as an upper limit; when the imaged middle is large it foveates internally (HQ/LQ/HQ), while both chronological edges stay verbatim text.
- No model, API key, or network is involved, so snapcompact is also safe for overflow recovery. It requires a vision-capable current model (`model.input` includes `"image"`); otherwise automatic maintenance skips it and advances to the next configured method. Manual `/compact` honors the method order unless custom instructions are given (those imply a directed LLM summary).
- Rationale: the shape table comes from the snapcompact 200k-token evals in `packages/snapcompact`, where bitmap frames preserved QA recall at lower billed-token cost than raw text for vision-capable models.

The archive's 80-frame default is an upper bound, not a promised frame count. Session maintenance also caps frames by available context, the provider image budget, and `FRAME_DATA_BYTES_BUDGET` (3,000,000 bytes). A rendered archive that exceeds standing-payload or context budgets is rejected/skipped rather than committed as an unusable prompt.

### Maintenance progress guard

Automatic maintenance checks that the rewritten context creates real headroom (normally at or below 80% of the resolved threshold) before scheduling continuation. No-progress passes can try local rescue: re-render an existing snapcompact archive with a smaller frame budget, elide heavy blocks to recoverable artifacts, or drop attached images. Archive rescue can truncate the oldest carried source text; image dropping is destructive. If maintenance still cannot create headroom, it emits a warning and blocks automatic continuation instead of looping on the same oversized context.

### Display transcript

Compaction no longer visually restarts the conversation. The TUI renders the **display transcript** (`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`): every path entry in chronological order, with each compaction shown inline as a slim divider — `── 📷 compacted · ctrl+o ──` — at the point it fired. Expanding (ctrl+o) reveals the summary. Only the LLM context resets at the compaction boundary; the scrollback above the divider stays intact, including across session resume.

With CLM enabled, the display transcript also shows context-document maintenance; none of it changes what the model receives:

- **Pressure, urgent, and spill notices** render as one status row restating the fact (estimated request tokens against the soft limit, the reply cap when one applies). Pressure is dim; urgent and spill take the warning color. Ctrl+O reveals the exact notice text the model got.
- **Context edits** render as a `✎ Context edit` card. A staged write shows its base revision, snapshot, and draft counts, and updates in place if validation rejects it (reason in the error color). The committed card, placed at the revision's position in history, shows `old→new` revisions, estimated request tokens before→after, removed items and added notes, and archive growth; collapsed it lists the first two removed items, and Ctrl+O lists each removed item and note by archive id (`h…`), kind, tokens, and a one-line preview. `compaction.clmShowContextEdits: off` keeps the plain dim `clm: …` receipt lines instead. Staged cards are live-only. Pressure/urgent/spill chips and receipts of drafts rejected at the turn boundary are journaled with the CLM feedback the model receives and replay at its position; a write rejected while staging (the failure reached the model as that tool call's error) shows its card live only. Committed cards, notes, and dimming are rebuilt from the session journal, so a resumed session renders the same.
- **Rewritten history**: transcript entries a committed revision removed from the model's context (deleted or collapsed into a note) render dim behind a `▏` gutter under one header naming the revision, the token delta, and the archive ids to recall. A commit rebuilds the transcript (clearing native scrollback, as compaction does), and `/context restore` un-dims entries the restored revision brings back.
- **Model notes** a revision adds render as a `✎ clm-note · model-authored · <revision>` card after the edit card; long notes collapse behind Ctrl+O.

### Pre-compaction pruning

Before compaction checks, tool-result pruning may run (`pruneToolOutputs`).

Default prune policy:

- Protect newest `40_000` tool-output tokens.
- Require at least `20_000` total estimated savings.
- Never blank a result below `50` tokens (`MIN_PRUNE_TOKENS`): the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a sub-floor result would grow the context and churn the prompt cache for nothing. (Superseded and useless results keep their own rules — the useless collector already drops no-savings candidates; superseded reads prune for correctness regardless of size.)
- Never prune `skill` tool results, `read` results of `skill://` paths, or reads of the active plan reference file (added via `AgentSession`'s plan protection).

Pruned tool results are replaced with:

- `[Output truncated - N tokens]`

If pruning changes entries, session storage is rewritten and agent message state is refreshed before compaction decisions.

### Useless-result elision

Tools can flag a finished result as contextually useless — a search with zero matches or a `wait` safety cap that returned only still-running work. The flag originates on the tool result (`AgentToolResult.useless`, set via `ToolResultBuilder.useless()` or directly on the returned object), is copied by the agent loop onto the persisted `ToolResultMessage` (never together with `isError` — errors always win), and is consumed in three places:

- **Per-turn stale-result pass** (`pruneSupersededToolResults`, gated by `compaction.dropUseless`, default on): flagged results are blanked to the exact placeholder `[Uneventful result elided]` (`USELESS_NOTICE`) with the same cache-aware timing as superseded reads — only when the suffix after the candidate is small (≤ ~8k tokens) or the session has idled past the provider prompt-cache lifetime. Results smaller than the notice itself are never blanked (no savings), and protected tools are exempt.
- **Threshold prune** (`pruneToolOutputs`): flagged results bypass the protect-recent window, same as superseded reads, and receive `USELESS_NOTICE` instead of the token-count placeholder.
- **Summary serialization**: `serializeConversation` (agent and snapcompact) drops the whole tool call/result pair from summarizer/archive input — the source region is discarded after summarization anyway, so the exclusion costs no cache.

The flag never reaches provider wire formats, and flagged pairs are never removed from history (only blanked in place), so tool-call/result pairing and provider-native history replay stay intact.

### Boundary and cut-point logic

`prepareCompaction()` builds one effective message sequence for estimation, cut-point selection, and the history-summary, turn-prefix, and retained-message regions.

1. Find the latest compaction whose summary or provider-native history is reusable by the active model.
2. Honor the latest `/clear` `reset_boundary`: a newer reset discards the previous summary, and an older reset remains the lower bound for recovering retained messages.
3. For a local summary, recover the original entries from `firstKeptEntryId` up to the previous compaction record, then append entries after that record.
4. For reusable provider-native history, start after `providerReplayThroughEntryId` when it identifies an older snapshot, without crossing the latest reset boundary. This recovers the uncovered snapshot-to-commit interval, not the original messages already covered by native replay. A trailing native compaction record does not make that interval already compacted.
5. Exclude compaction records and other non-message metadata. Pass the previous summary separately through `previousSummary`; retain message-bearing `custom_message` and `branch_summary` entries.
6. Adapt `keepRecentTokens` using the measured usage ratio, then run `findCutPoint()` and partition that same sequence into `messagesToSummarize`, `turnPrefixMessages`, and `recentMessages`.

When updating a local summary, every effective original message belongs to exactly one of those three regions. For example, after `summary(A) + B` grows to `summary(A) + B + C`, the next preparation distributes both B and C, not just C. The new `firstKeptEntryId` refers to an original entry; preparation does not move, duplicate, or rewrite journal entries. This is a local-summary preparation guarantee, not an end-to-end guarantee for provider-native or speculative native replay.

Valid cut points include:

- message entries with roles: `user`, `assistant`, `bashExecution`, `hookMessage`, `branchSummary`, `compactionSummary`
- `custom_message` entries
- `branch_summary` entries

Hard rule: never cut at `toolResult`.

Preparation filters out pure metadata (`model_change`, `thinking_level_change`, labels, etc.) before selecting the retained-message boundary. Those records remain in the journal but are not conversation input.

### Split-turn handling

If cut point is not at a user-turn start, compaction treats it as a split turn.

Turn start detection treats these as user-turn boundaries:

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` entry
- `branch_summary` entry

Split-turn compaction generates two summaries:

1. History summary (`messagesToSummarize`)
2. Turn-prefix summary (`turnPrefixMessages`)

Final stored summary is merged as:

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### Summary generation

`compact(...)` builds summaries from serialized conversation text:

1. Convert messages via `convertToLlm()`.
2. Serialize with `serializeConversationForSummary()` using the target model's preferred dialect.
3. Wrap in `<conversation>...</conversation>`.
4. Optionally include `<previous-summary>...</previous-summary>`.
5. Optionally inject extension hook context and active memory-backend compaction context as `<additional-context>` entries.
6. Execute summarization prompt with `SUMMARIZATION_SYSTEM_PROMPT`.

Oversized local-summary input is folded through budgeted conversation windows, carrying each summary into the next update. Provider context-overflow rejections halve and re-plan the rejected window down to a minimum input budget; other failures surface normally.

Prompt selection:

- first compaction: `compaction-summary.md`
- iterative compaction with prior summary: `compaction-update-summary.md`
- split-turn second pass: `compaction-turn-prefix.md`
- short UI summary: `compaction-short-summary.md`
- handoff document: `handoff-document.md` (used by `generateHandoff(...)`, not serialized compaction)

Remote summarization modes, consulted in order (each stage falls back to the next while one is available):

- **V2 streaming Responses compaction** (tried first, on by default via `compaction.remoteStreamingV2Enabled`): for eligible models — `shouldUseCompactionV2Streaming(...)`: `openai-responses`, `azure-openai-responses`, or `openai-codex-responses` APIs with `remoteCompaction.v2StreamingEnabled` (on by default for Amazon Bedrock's OpenAI routes, see below) and a resolvable Responses endpoint — compaction forwards the full conversation, including provider-native tool-call history replay, to the model's normal Responses streaming endpoint with a trailing `compaction_trigger` input item, and requires exactly one streamed `compaction` output item. The request carries session routing and prompt-cache identifiers (routing/session-id headers plus `prompt_cache_key`) and resolves the model's reasoning effort the same way a normal turn does. Replacement history is Codex-style: retained real user messages within the `compaction.v2RetainedMessageBudget` (default `64000` tokens, clamped to that ceiling) followed by the compaction item, stored in `preserveData.openaiRemoteCompaction` (version `"v2"`). Transient stream errors retry up to `V2_COMPACTION_MAX_RETRIES` (`2`) times with exponential backoff under a five-minute timeout (`V2_COMPACTION_TIMEOUT_MS`, same as V1); user aborts are never retried.
- **V1 native `/responses/compact`**: for OpenAI models, OpenAI Codex models with an explicit compatible `remoteCompaction.endpoint`, and `openai-responses` models on Amazon Bedrock's OpenAI routes (`shouldUseOpenAiRemoteCompaction`), when remote compaction is enabled and V2 did not run (ineligible or failed), compaction tries the provider-native `/responses/compact` endpoint. It preserves provider replacement history in `preserveData.openaiRemoteCompaction`. A native failure surfaces its transport error instead of silently switching to generic summarization — unless `compaction.remoteEndpoint` is set, in which case summary generation falls through to that endpoint/local summarization.
- **Anthropic on-demand compaction** (`compact-2026-09-04` beta): for model lines the beta supports (`compat.supportsServerCompaction`, a catalog rule: Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5+ on the `anthropic`, `google-vertex`, `amazon-bedrock`, and `bedrock-mantle` providers) whose effective endpoint implements it (`shouldUseAnthropicNativeCompaction`: the Claude API, Vertex, Foundry, Claude Platform on AWS, and Amazon Bedrock's `/anthropic` routes; another provider reaching one of the first four needs `remoteCompaction.enabled`, and unknown gateway URLs stay excluded), when remote compaction is enabled and no OpenAI lane applies. Compaction sends the history to summarize with the live conversation's system prompt, tools, and thinking settings, plus a top-level `compaction: { type: "summarize", instructions }` parameter carrying the harness summary prompt. The API answers with one signed `compaction` block (`stop_reason: "compaction"`), surfaced as an `anthropicCompaction` payload. Its plain-text summary becomes the entry `summary` (plus the file-operation list) **and** `preserveData.anthropicCompaction`; later requests on a compaction-capable endpoint send the block back unchanged as the first block, while every other provider reads the summary text. The retained tail after the cut point is replayed from session entries like a local summary. A response without a signed summary, such as a refusal, an output limit, or a tool call during summarization, is a native failure, like the OpenAI lanes. Blocks written by the older `compact-2026-01-12` threshold beta (`encryptedContent`) are replay-only.
   - On Amazon Bedrock, use `https://bedrock-runtime.<region>.amazonaws.com/anthropic` or `https://bedrock-mantle.<region>.api.aws/anthropic` ([setup](./models.md#claude-on-bedrocks-anthropic-messages-api-anthropic)); the FIPS and PrivateLink hostnames listed below for the OpenAI routes count too. The gate reads `compat.bedrockMessagesApi`, detected from such a `baseUrl`; set it in `models.yml` to opt a proxy or an `ANTHROPIC_BASE_URL` reroute in, or `false` to opt a Bedrock route out. Converse and InvokeModel (`/model/...`) requests never compact natively; Converse rejects the beta ([AWS compaction guide](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html)).
- **Custom remote endpoint**: if `compaction.remoteEndpoint` is set and remote compaction is enabled, local summary generation POSTs one of two wire formats:
   - custom omp summarizer endpoints receive `{ systemPrompt, prompt, maxTokens }` and must return JSON containing at least `{ summary }`.
   - OpenAI-compatible endpoints whose path ends in `/chat/completions` receive `{ model, messages, stream: false, max_tokens }`, where `messages` contains one system prompt and one user prompt. The summary is read from `choices[0].message.content`, which lets self-hosted servers such as llama.cpp and vLLM act as remote compactors without a separate summarizer shim.

Amazon Bedrock's OpenAI routes get both OpenAI lanes without an opt-in. The route is detected from the model `baseUrl` (`isBedrockOpenAIUrl` in `packages/catalog/src/hosts.ts`), for any provider id with `api: openai-responses`: an HTTPS `/openai/…` path on a `bedrock-runtime` or `bedrock-mantle` endpoint, or Mantle's documented `/v1` base. Endpoint hostnames are the public ones (`bedrock-runtime.<region>.amazonaws.com`, FIPS `bedrock-runtime-fips.<region>.amazonaws.com`, `bedrock-mantle.<region>.api.aws`, including the bundled `bedrock-mantle` provider's `{region}` template) and AWS PrivateLink endpoint-specific names (`<vpce-id>[-<az>].bedrock-runtime[-fips].<region>.vpce.amazonaws.com` or `….bedrock-mantle.<region>.vpce.amazonaws.com`); a VPC endpoint with private DNS answers on the public names ([Endpoints supported by Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html), [Bedrock service endpoints](https://docs.aws.amazon.com/general/latest/gr/bedrock.html), [Bedrock VPC endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html), [PrivateLink DNS names](https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-access-aws-services.html)). Other Bedrock paths, such as `/anthropic`, `/v1` on bedrock-runtime, or the Converse root, do not count. On these Bedrock routes only, both compaction requests are shaped like a normal Bedrock turn by `prepareBedrockCompactionRequest` (`packages/agent/src/compaction/bedrock.ts`): configured headers are resolved, the transport fetch applies (provider proxy, extra CA, User-Agent, request recording), and the provider's own request hooks run. So the bundled `bedrock-mantle` provider fills in `{region}` and uses its bearer token or SigV4 signing. Other providers' compaction requests keep their own transport. To turn the default off for a model or provider in `models.yml`, set `remoteCompaction.enabled: false` (both lanes) or `remoteCompaction.v2StreamingEnabled: false` (V1 only). AWS documents the Responses API on both endpoints ([Responses API](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-responses-api.html)), and OpenAI lists Bedrock's feature coverage ([OpenAI models in Amazon Bedrock](https://developers.openai.com/api/docs/guides/amazon-bedrock)). None of these pages mention compaction. Support was verified live instead, on 2026-09-25 with a Bedrock API key (not SigV4) on the public `/openai/v1` bases: in `us-east-1`, V1 `POST {base}/responses/compact` returned `object: "response.compaction"` and V2 streamed a `compaction` output item on `bedrock-runtime` (`us.openai.gpt-6-astra`, `-sol`, `-luna`) and on `bedrock-mantle` (`openai.gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.5`, `gpt-5.4`). FIPS, PrivateLink, and Mantle `/v1` bases reach the same services but were not verified live. `openai.gpt-oss-120b` on Mantle does not support the Responses API.

When a native remote compaction (V2, V1, or Anthropic) succeeds, local LLM summarization is skipped entirely. For the OpenAI lanes the durable history lives in the provider replay payload and the stored `summary` is a placeholder lead-in plus the file-operation list; the Anthropic lane stores the real summary text, so a later compaction by any provider can build on it.

When native compaction starts from an ordinary local summary, that summary is included as a context message alongside the prepared conversation. Later native passes reuse the provider payload instead of re-injecting its placeholder summary. Snapcompact source text keeps its separate archive migration path.

For speculative native compaction, `providerReplayThroughEntryId` records the snapshot's last entry, not the later commit position. Context rebuilding and the next compaction preparation both include messages appended between those positions, followed by post-commit messages. The native payload and uncovered interval are replayed once each; `/clear` discards both when it supersedes that compaction.

Advisor runtimes retain native `preserveData` for subsequent maintenance and attach its provider payload to the in-memory compaction summary for the next model request. Native replay already contains the retained tail, so advisors do not also append that tail as raw messages. Local summaries still keep recent messages separately. Advisor requests use the shared message converter so both textual compaction summaries and native payloads reach the provider.

### Handoff generation

`packages/agent/src/compaction/compaction.ts` exports `generateHandoff(...)` and `generateHandoffFromContext(...)`. Coding-agent uses the context-aware function through `SessionHandoff`: the side request uses the base system prompt, normalized tools, transformed live history, and live prompt-cache key, with a unique side session id and trailing agent-attributed `user` handoff prompt. It starts with `toolChoice: "none"` and retries once with `"auto"` only after an explicit-tool-choice compatibility rejection. Only joined text blocks are returned; tools are never dispatched. See [the handoff pipeline](./handoff-generation-pipeline.md).

Handoff commits a regular `CompactionEntry` on the current session: `SessionMaintenance.handoff()` (manual `/handoff`) and the auto-maintenance `handoff` method both generate the document via `SessionHandoff.generateDocument()` and store it as the compaction summary with `firstKeptEntryId` from `prepareCompaction`, so recent history is kept and the session id, transcript, and provider cache key are unchanged.

When `compaction.handoffSaveToDisk` is enabled, an **automatically triggered** handoff also writes `handoff-<ISO timestamp>.md` in the persisted session's artifact directory. Manual handoffs are not written by this setting, and non-persisted sessions have no artifact directory.

### File-operation context in summaries

Compaction tracks cumulative file activity using assistant tool calls:

- `read(path)` → read set
- `write(path)` → modified set
- `edit(path)` → modified set

Cumulative behavior:

- Includes prior compaction details only when prior entry is pi-generated (`fromExtension !== true`).
- In split turns, includes turn-prefix file ops too.
- `details.readFiles` excludes files also modified; `details.modifiedFiles` carries the rest (persisted shape is unchanged).

The file list is a grouped, prefix-folded directory tree (find-tool shape) with a per-file access marker — `(Read)` for read-only files, `(Write)` for modified files never read, `(RW)` for modified files also present in the cumulative read set. Capped at 20 files with an `[…N files elided…]` line. LLM-summary strategies append it as a `<files>` tag (via `upsertFileOperations`); snapcompact renders it inside its summary template as a `FILES` section instead.

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

Legacy `<read-files>`/`<modified-files>` tags from summaries written by earlier versions are stripped (alongside `<files>`) before re-appending, so old summaries self-heal on the next compaction.

### Persist and reload

After summary generation (or hook-provided summary), agent session:

1. Appends `CompactionEntry` with `appendCompaction(...)`; the handoff method commits the generated document as the entry's summary on the same session.
2. Rebuilds display context from the active leaf via `buildDisplaySessionContext()`.
3. Replaces live agent messages with rebuilt context.
4. Synchronizes active todo phases from the rebuilt branch and closes provider sessions whose history was rewritten.
5. Emits `session_compact` hook event.

## Branch summarization pipeline

Branch summarization is tied to tree navigation, not token overflow.

### Trigger

During `navigateTree(...)`:

1. Compute abandoned entries from old leaf to common ancestor using `collectEntriesForBranchSummary(...)`.
2. If caller requested summary (`options.summarize`), generate summary before switching leaf.
3. If summary exists, attach it at the navigation target using `branchWithSummary(...)`.

Operationally this is commonly driven by `/tree` flow when `branchSummary.enabled` is enabled.

### Branch switch shape (visual)

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D (abandoned branch, unchanged)
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Preparation and token budget

`generateBranchSummary(...)` computes budget as:

- `tokenBudget = (model.contextWindow || 128000) - branchSummary.reserveTokens`

`prepareBranchEntries(...)` then:

1. First pass: collect cumulative file ops from all summarized entries, including prior pi-generated `branch_summary` details.
2. Second pass: walk newest → oldest, adding messages until token budget is reached.
3. Prefer preserving recent context.
4. May still include large summary entries near budget edge for continuity.

Compaction entries are included as messages (`compactionSummary`) during branch summarization input.

### Summary generation and persistence

Branch summarization:

1. Converts and serializes selected messages with `serializeConversationForSummary()` and the target model's preferred dialect.
2. Wraps in `<conversation>`.
3. Uses custom instructions if supplied, otherwise `branch-summary.md`.
4. Calls summarization model with `SUMMARIZATION_SYSTEM_PROMPT` and a 2,048-token output limit.
5. Prepends `branch-summary-preamble.md`.
6. Appends file-operation tags.

Result is stored as `BranchSummaryEntry` with optional details (`readFiles`, `modifiedFiles`).

## Extension and hook touchpoints

### `session_before_compact`

Pre-compaction hook.

Can:

- cancel compaction (`{ cancel: true }`)
- provide full custom compaction payload (`{ compaction: CompactionResult }`)

The hook's `customInstructions` carries only the public user focus. Internal summarizer guidance — currently the plan-mode "Approve and compact context" distillation prompt — travels a separate `internalGuidance` channel on `CompactOptions` that reaches only native summarization, never this hook or `session.compacting`; when both are set the summarizer uses `internalGuidance` while hooks still see the public `customInstructions` (issue #4359).

### `session.compacting`

Prompt/context customization hook for default compaction.

Can return:

- `prompt` (override base summary prompt)
- `context` (extra context lines injected into `<additional-context>`)
- `preserveData` (stored on compaction entry)

### `session_compact`

Post-compaction notification with saved `compactionEntry` and `fromExtension` flag.

### `session_before_tree`

Runs on tree navigation before default branch summary generation.

Can:

- cancel navigation
- provide custom `{ summary: { summary, details } }` used when user requested summarization

### `session_tree`

Post-navigation event exposing new/old leaf and optional summary entry.

## Runtime behavior and failure semantics

- Manual compaction aborts current agent operation first. If that abort cut a turn in flight, the compaction resumes it once the summary is committed — or immediately when it rejects as a no-op (session too small / already compacted), since that pass makes no history change — using a queued steer/follow-up first, otherwise the auto-continue prompt. A hook cancel or summarizer failure does not resume. The resume is skipped when `compaction.autoContinue` is `false` or the caller passed `suppressContinuation` (plan-mode approval dispatches its own execution turn). A manual compaction issued while idle never starts a turn. A prompt submitted while the compaction runs waits for it and, if it starts or queues a turn, replaces the resume; a locally handled extension/custom command hands the resume back — unless a turn it triggered (`pi.sendMessage(..., { triggerTurn: true })`, `pi.sendUserMessage()`), a later prompt, or any other turn starts first. A second manual compaction started while such a resume is still withheld takes it over.
- `abortCompaction()` cancels manual compaction, auto-compaction, and handoff generation controllers.
- Auto compaction emits start/end session events for UI/state updates.
- Auto compaction can try multiple model candidates and retry transient failures; long retry delays prefer the next candidate when one is available.
- Overflow errors are excluded from generic retry path because they are handled by context promotion/compaction.
- If auto-compaction fails:
   - overflow path emits `Context overflow recovery failed: ...`
   - incomplete-output path emits `Incomplete response recovery failed: ...`
   - threshold/idle paths emit `Auto-compaction failed: ...`
- Branch summarization can be cancelled via abort signal (e.g., Escape), returning canceled/aborted navigation result.

## Settings and defaults

Defined in `packages/coding-agent/src/session/context-settings.ts`:

- `compaction.enabled` = `true`
- `compaction.experimentalContextManagement` = `false`. Opt-in persistent notes, branch-bound raw-history retrieval, and local context-window rollover; toggling it adds or removes `context_notes`/`new_context` in the running session.
- `compaction.methodOrder` = `["remote", "snapcompact", "handoff", "shake", "soft"]`. `remote` uses provider-native server compaction (OpenAI Responses compact, Anthropic compaction beta) when available; unavailable or failed methods advance to the next preference.
- `compaction.asyncEnabled` = `true`. Async (speculative) compaction: when context enters the pre-threshold band `[threshold − lead, threshold)` (lead = `clamp(threshold × 0.125, 8192, 32000)`), maintenance starts a background summarization for the first configured LLM-backed method (`remote`, `handoff`, or `soft`) off a branch snapshot, isolated from the live turn by a side session id. The armed result is committed instantly when the threshold is actually crossed, hiding summarization latency; post-snapshot turns are appended after the summary unchanged. Armed results are discarded when the branch prefix changes (new compaction, reset boundary, `/tree` navigation), when a provider-native replay payload is no longer readable by the active model, or when context grows past `keepRecentTokens` since compute (a fresh speculation replaces it). Speculation is skipped while an extension registers `session_before_compact`. The status line pulses the auto-compact icon while a speculation runs and holds it in accent when a result is armed.
- `compaction.reserveTokens` is unset by default. The effective reserve is `max(floor(contextWindow × 0.15), configuredReserve ?? 16384)`. Budget checks use the proportional reserve when the unset default is impractical on a small window, or when the effective reserve reaches/exceeds the whole window. Explicit reserves otherwise retain the 15% floor.
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`; a `false` value applies to the session that configured it, not to spawned subagents — each subagent keeps mid-run checks so its single-turn assignment still compacts at the configured threshold.
- `compaction.handoffSaveToDisk` = `false`
- The `handoff` method generates a handoff document through the live-cache side-request pipeline and commits it as a compaction entry on the current session (no new session is created); `/handoff` does the same manually.
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1` and `compaction.thresholdTokens` = `-1`; a positive fixed token limit takes precedence over percentage, and otherwise the reserve-based threshold is used.
- `task.agentCompactionThresholdOverrides` = `{}`; exact-name task/eval agent → token count (`90000`) or percentage (`"80%"`) replacing both thresholds for that agent only. See [Settings](./settings.md#context-compaction-and-memory).
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `snapcompact.systemPrompt` = `"none"` (`"agents-md"` and `"all"` opt into transient system-prompt imaging)
- `snapcompact.toolResults` = `false` (transient imaging of large historical tool results)
- `snapcompact.shape` = `"auto"`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

These values are consumed at runtime by `AgentSession`, `SessionMaintenance`, and the compaction/branch-summarization modules.
