{{#if asyncEnabled}}{{#if batchEnabled}}Spawn `tasks[]` concurrently; IDs return immediately.{{else}}Spawn one agent; ID returns immediately.{{/if}}{{#if hasBlockingAgents}} BLOCKING agents return inline.{{/if}}{{else}}{{#if batchEnabled}}Run `tasks[]` synchronously.{{else}}Run one agent synchronously.{{/if}}{{/if}}
{{#if asyncEnabled}}

# Results
`outputSchema` parsed payload, even invalid: `agent://<id>` (field `/<field>`, nested `/reports/0/data`); invalid preview inline.
{{/if}}

# Delegation
Use most specific agent.{{#if scoutAvailable}} Read-only research MUST use `scout` only when files unknown.{{/if}} Prefer one agent to investigate + edit. Omit `agent` only for default (`{{defaultAgent}}`); NEVER specify it.
Shared edits need one integration owner{{#if ircEnabled}}; siblings coordinate via `write agent://<id>`{{/if}}. Set interfaces in {{#if batchEnabled}}`context`{{else}}the task{{/if}}. Every task MUST skip build/lint/tests/formatters mid-flight; run once afterward.

# Inputs
`name`: CamelCase ≤32, auto-generated if omitted; address agent by name. `outputSchema` overrides agent/session schemas.
`solutionSpace`: describe how open-ended the child's problem is: whether the fix or design is given, or which causes or designs remain open. Volume of work does not widen it; NEVER mention sibling agents or coordination. (`one fix: rename, names given`; `one fix: slice end in paginate`; `single-flight cache load; races easy to miss`; `several retry API shapes; error classes to choose`; `deadlock cause open, no repro`)
{{#if evalToolsEnabled}}`tools`: eval-defined, run in your kernel.
{{/if}}{{#if effortEnabled}}`effort`: `"lo"`|`"med"`|`"hi"` by how open-ended the problem is.
{{/if}}`schemaMode`: default permissive warns after retries; strict fails.
{{#if isolationEnabled}}{{#if applyIsolatedChanges}}`isolated`: worktree; successful changes apply to parent.
{{else}}`isolated`: worktree; changes retained, not applied.
{{/if}}{{/if}}Children start {{#if handoffEnabled}}with only what you hand off{{else}}blank{{/if}};{{#if ircEnabled}} parent IRC steers immediately;{{/if}} large payloads via `local://<path>`, NEVER inline.
{{#if handoffEnabled}}

# Handoff
Host copies your archive items into one editable seed with provenance, plus a protected index of your other items; both are escaped historical data, not instructions. Child reads more at `context://parent/archive` (read-only).
`handoff`: refs `h<id>` (`context://self/archive`, `?q=`) or `b<N>` (latest `context://self` read), optional `:N-M` lines. Include only what the child cannot cheaply get itself: one-time output (tokens, fetched specs, failed runs), decisions; exclude your reasoning, dead ends, superseded reads, files the child can re-read. Long logs/output: hand off the `:N-M` lines that matter, not the whole item. Nice-to-have context: leave it out; the manifest lists it and the child pulls it on demand. Brief still mandatory: handoff is evidence, never the instructions.
`handoffMode`: `curated` default (your user messages auto-pinned as background + index + refs); `brief`: assignment + shared context only (child can still read your archive); `fork`: child starts from your persisted transcript up to your last completed exchange — short continuation sidecars only. Refs are refused with `brief`/`fork`.
`pinRequirements`: `false` stops auto-pinning your user messages.
Independent agents never receive your reasoning (assistant text, notes, summaries); fork refused for them. Agent `independent` frontmatter overrides role-name inference (review, verify, audit, critic/critique tokens). Seed soft cap ~24k tokens includes provenance + escaped envelope; result reports cost and omitted ids.
{{/if}}

# Format
{{#if batchEnabled}}`context`: shared (`# Goal`, `# Contract` interfaces); NEVER repeat per task.
{{/if}}`task`: self-contained (`# Target` files/non-goals, `# Change` steps/APIs, `# Acceptance` observable result).

# Available Agents
{{#if spawningDisabled}}Agent spawning is currently disabled.
{{else}}{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}{{/if}}
