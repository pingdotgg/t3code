# Epic 25: Workflow Engine

## Purpose

This epic defines the **TS-native, replay-based durable-execution workflow engine** that
backs every action recipes can launch, every cross-thread interaction, and every script
that t3work runs on a user's behalf.

It supersedes the step-union JSON model and the forward-only execution loop described in
[Epic 16 — Workflows](./16-action-recipes.md#workflows). Recipes, surfaces, applicability,
and discovery are still owned by Epic 16; this epic owns the **engine** and the **author
surface**.

Treat this doc as authoritative for:

- workflow file shape (`.workflow.ts`),
- the `meta` block contract,
- the globals injected into the workflow body,
- the durable-execution / replay model,
- the determinism contract authors must follow (and how the engine enforces it),
- the `Handle<R>` pattern for primitives that fire something into the system,
- error classes and the workflow-catchable taxonomy,
- capability gating via `meta.capabilities`,
- how recipes thread typed workflow references into views.

## Why now

The current workflow runtime is a forward-only cursor over a persisted step list (see
[Epic 16 — Stateless, forward-only execution](./16-action-recipes.md)). It enables resume
across a single `collect-input` checkpoint and isolates per-step failures, but it cannot
express the things authors actually want:

- branching on the outcome of a previous step (try/catch, if/else),
- composing multiple LLM calls or scripts with intermediate transforms,
- structured request/response across threads or child sessions,
- escalation to the user mid-run with a typed reply,
- waiting on multi-hour or multi-day external events,
- safely calling another workflow as a sub-routine.

Today's authoring path is also a step-array of `{kind, …}` JSON objects with embedded
expression strings — exactly the heavy-JSON-config pattern that
[the project's authoring philosophy](./16-action-recipes.md#plugin-modules) rejects.

The new engine is **a real TypeScript workflow body** that runs under replay-based
durable execution (Temporal / Restate / DBOS / Inngest idiom). Authors write idiomatic
async TS with `try`/`catch`/`if`/`for` and call typed primitives. The engine journals
every primitive call and replays the body on resume to reach the next live call.

## Workflow file shape

A workflow lives in its own `.workflow.ts` file. There is no `defineWorkflow(async (ctx) => …)`
wrapper inside the file — the body **is** the function:

```ts
// .t3work/recipes/pr-review/actions/approve-and-merge.workflow.ts
import { Schema } from "effect";
import { githubWrite } from "@t3work/sdk/groups";

export const Inputs = Schema.Struct({
  prId: Schema.String,
});

export const Outputs = Schema.Union(
  Schema.Struct({ status: Schema.Literal("merged"), sha: Schema.String }),
  Schema.Struct({ status: Schema.Literal("blocked"), reason: Schema.String }),
);

export const meta = {
  name: "pr-review.approve-and-merge",
  description: "Approve a PR and merge it, escalating on protected-branch errors.",
  inputs: Inputs,
  outputs: Outputs,
  capabilities: ["user", githubWrite], // engine feature + typed group ref
  phases: [{ title: "Approve" }, { title: "Merge" }] as const, // `as const` types phase() against these titles
} as const;

const input = Schema.decodeSync(Inputs)(args);

phase("Approve"); // typed against meta.phases (via `as const`)
await tools.github.pullRequest.approve({ id: input.prId });

phase("Merge");
try {
  const { sha } = await tools.github.pullRequest.merge({ id: input.prId });
  return { status: "merged", sha };
} catch (e) {
  if (e instanceof PermissionDeniedError) {
    const ask = await user.ask({
      title: "Branch protected — request admin override?",
      responseSchema: Schema.Struct({ proceed: Schema.Boolean }),
    });
    const decision = await ask.response;
    if (!decision.proceed) {
      return { status: "blocked", reason: "Branch protected; user declined override." };
    }
    const { sha } = await tools.github.pullRequest.merge({
      id: input.prId,
      adminOverride: true,
    });
    return { status: "merged", sha };
  }
  throw e;
}
```

Three things make this file shape work under replay:

1. **`meta` is the first non-`const`/non-`import` statement** and is itself a pure
   literal (or references to top-level `const`s declared above it in the same file). The
   loader evaluates the consts in a no-globals sandbox and then extracts `meta` without
   running the body — needed for the launcher UI, capability gating, and applicability
   matching.
2. **The body is implicit async with top-level await.** No `async function` wrapper; the
   engine wraps the module's top-level statements.
3. **`args` is a global**, validated against `meta.inputs` _before_ the body runs. The
   `Schema.decodeSync(Inputs)(args)` line gives the body a typed handle without a build
   step.

Files conventionally live alongside the recipe that owns them, but workflows can also
live at the project root for shared use:

```text
.t3work/
  recipes/
    pr-review/
      recipe.ts
      actions/
        start-review.workflow.ts
        approve-and-merge.workflow.ts
        request-changes.workflow.ts
      views/
        PrItem.tsx
  workflows/
    release-notes-from-pr.workflow.ts       # shared, no recipe owner
```

Discovery is by filesystem scan for `*.workflow.ts`. Ownership comes from where
`defineWorkflow(path)` is called, not from where the file sits.

## The `meta` block

```ts
export const meta = {
  name: string;                          // required, kebab-case, unique within the project
  description: string;                   // required, one sentence
  inputs?:  Schema.Schema<unknown>;      // Effect Schema; validated before body runs
  outputs?: Schema.Schema<unknown>;      // Effect Schema; validated before result is returned
  capabilities?: ReadonlyArray<EngineCapability | ToolGroupRef>;   // see §Capability gating
  phases?: ReadonlyArray<{ title: string; detail?: string }>;       // progress UI groups; declare with `as const` for typed phase() calls
  model?: ModelSelection;                // default model for agent/agent.task calls
};
```

### Static-extraction rules

`meta` is read at workflow-load time **before** the body runs. The loader evaluates only
the top-level `const` declarations referenced by `meta` (e.g. `Inputs`, `Outputs`) in a
sandbox that exposes no engine primitives. This is what makes capability gating and
permission UI safe to display before the user authorizes execution.

What's allowed in `meta`:

- Pure literals.
- Identifiers bound to top-level `const`s declared above `meta` in the same file.
- Effect Schema combinators (`Schema.Struct`, `Schema.Union`, `Schema.Literal`, etc.) —
  these are pure and side-effect-free.
- Value imports from the engine's pure-modules allowlist:
  - `effect` (Schema combinators, etc.)
  - `@t3work/sdk/groups` (typed `ToolGroupRef`s)
  - `@t3work/sdk/models` (typed `ModelRef`s; see [§Model selection](#model-selection))
  - `@t3work/sdk/surfaces` (typed surface placement consts — optional; raw `RecipeSurface`
    literal strings also work since they're a closed-set Schema.Literals union)
  - any other modules the SDK adds to the allowlist in future releases

  Project-local modules are **not** allowlisted — `meta` cannot import from
  `./something.ts`. Use top-level `const` declarations in the same file instead.

What's forbidden in `meta`:

- Function calls that touch engine globals (`agent`, `scripts.*`, `tools.*`, `thread.*`,
  `child.*`, `user.*`, `ui.*`, `wait`, …) — these aren't bound during meta extraction
  and will throw.
- Any expression with side effects (reads from `fs`, `process`, `globalThis`, …).
- Conditional logic (`?:`, `&&`, `||` in identity-affecting positions) — keep `meta`
  declarative.

### Model selection

`meta.model` selects the default LLM for `agent` and `agent.task` calls. Per the
type-safety principle, the model identifier is a typed `ModelRef` from the SDK's
`models.*` registry, not a free-form string. Provider instance ids stay as strings
because they reference user-configured provider instances (dynamic per installation,
not knowable at SDK build time):

```ts
import { models } from "@t3work/sdk/models";

export const meta = {
  // …
  model: {
    provider: "anthropic-primary", // project-configured provider instance id (string)
    model: models.anthropic.claudeHaiku45, // typed ModelRef — autocomplete + typo-safe
  },
} as const;
```

`models.*` is a typed ambient tree mirroring the providers and model slugs the SDK knows
about (`models.anthropic.claudeOpus47`, `models.openai.gpt5_4`, etc.). Each leaf is a
`ModelRef` whose `id` is the canonical provider-scoped slug. The engine still passes the
string slug to the provider adapter; the type is what authors interact with.

`meta.model` is the workflow-wide default. Individual `agent.task({ model: … })` calls
can override per-call (same `{ provider, model: ModelRef }` shape; gated by the
workflow's declared model constraints — see [§Open question 3](#open-questions)).

## Globals — the surface

The engine injects globals into the workflow body. There are no `import` statements for
engine APIs. Authors get full IntelliSense via a `.workflow.ts`-specific ambient `.d.ts`
that ships with `@t3work/workflow-sdk`.

### LLM and orchestration (inherited from the Claude Code Workflow tool, adapted)

| Global                   | Returns                       | Notes                                                                                                                                                                                                             |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent(prompt, opts?)`   | `Promise<string \| T>`        | Spawn a one-shot agent in a fresh context window. With `schema: Schema<T>`, returns typed `T`.                                                                                                                    |
| `agent.task(opts)`       | `Promise<T>`                  | Non-interactive LLM call with a structured-output schema. Never touches a thread.                                                                                                                                 |
| `parallel(thunks)`       | `Promise<R[]>`                | Concurrent fanout with a barrier. Failing thunks resolve to `null`.                                                                                                                                               |
| `pipeline(items, …stgs)` | `Promise<R[]>`                | Per-item pipelined fanout — no barrier between stages.                                                                                                                                                            |
| `workflow(ref, args?)`   | `Promise<O>`                  | Run another workflow inline as a sub-step. `ref` must be a typed `WorkflowRef` (no string form — declare refs via `defineWorkflow`). One level of nesting; cycles refused.                                        |
| `phase(title)`           | `void`                        | Start a progress group. `title` is typed as the union of `meta.phases[].title` literals when `meta.phases` is declared `as const` (recommended). Calling with a title outside that union is a compile-time error. |
| `log(message)`           | `void`                        | Emit a narrator line above the progress tree.                                                                                                                                                                     |
| `args`                   | `unknown`                     | The workflow's input; validated against `meta.inputs` before the body runs.                                                                                                                                       |
| `budget`                 | `{ total, spent, remaining }` | Token budget shared with nested workflows.                                                                                                                                                                        |

### Side-effect primitives (the Handle pattern)

Every primitive that fires something into the system returns a `Handle<R>`. If the call
declares a `responseSchema`, the handle's type is `Handle<R>` with `.response: Promise<R>`.
If not, it's `Handle<never>` and `.response` is not on the type. See [§The Handle pattern](#the-handle-pattern) for the contract.

| Global                                | Handle type                | Purpose                                                                                                                                           |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.show(view)`                       | `Handle<ResponseOf<View>>` | Render a View into the current conversation as a system message.                                                                                  |
| `thread.send(target, payload, opts?)` | `Handle<R>`                | Send a payload to a thread. `target: ThreadTarget` — see [§Thread targets](#thread-targets).                                                      |
| `child.spawn(opts)`                   | `Handle<R>`                | Spawn a child thread; inherits parent's context by default. The returned handle's `id` doubles as a `ThreadTarget` for later `thread.send` calls. |
| `user.ask(opts)`                      | `Handle<R>`                | Escalate to the user out-of-band; needs `responseSchema`.                                                                                         |
| `user.notify(message \| view)`        | `Handle<never>`            | Fire-and-forget user notification (toast or escalation panel).                                                                                    |

#### Thread targets

`thread.send`'s first argument is a typed `ThreadTarget`, not a string:

```ts
type ThreadTarget = ThreadRef | ChildHandle<unknown> | "self";

// Constants and constructors:
thread.parent; // ThreadRef | undefined — the parent of the current workflow's thread
thread.byId(id); // ThreadRef — explicit construction from a raw id string
// (use only when you got the id from a typed source, e.g. context)
("self"); // string literal — current workflow's thread (engine recognizes it)

// Plus any ChildHandle returned from child.spawn(...) — usable directly as a target.
```

Examples:

```ts
const tail = await child.spawn({ name: "Tail logs", kickoffPrompt: "…" });
await thread.send(tail, { kind: "rotate" }); // pass the handle directly

if (thread.parent) {
  await thread.send(thread.parent, { kind: "status", text: "merged" });
}

await thread.send("self", { kind: "log", text: "checkpoint" });
```

Raw string targets (`"parent"`, `` `child:${id}` ``, `` `thread:${id}` ``) are not
accepted. The interpolated forms in particular were a typo-trap; the typed surface
makes the wrong-id-format error a compile-time one.

### Other primitives — durable timers and journaled side effects

| Global                       | Returns         | Notes                                                                                                                                  |
| ---------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts.<name>(args)`       | `Promise<T>`    | Call a recipe-registered script (typed). Result is journaled. See [§Scripts](#scripts). Gated by the `"script"` engine capability.     |
| `tools.<group>.<name>(args)` | `Promise<T>`    | Call a broker tool. ToolRefs are typed; the ref's group is checked against `meta.capabilities` at the call site. See [§Tools](#tools). |
| `wait(durationMs)`           | `Promise<void>` | Durable timer — suspends the workflow if the deadline hasn't passed. Survives server restart.                                          |
| `random()`                   | `number`        | Journaled `[0, 1)` PRNG. Use instead of `Math.random()`.                                                                               |
| `now()`                      | `number`        | Journaled epoch millis. Use instead of `Date.now()`.                                                                                   |
| `uuid()`                     | `string`        | Journaled UUIDv4. Use instead of `crypto.randomUUID()`.                                                                                |

`script` and `tool` may take arbitrary wall-clock time but don't durably suspend — they
block on a Promise that the engine awaits and journals when it resolves. `wait` is the
only non-Handle primitive that can suspend the workflow durably across a server restart.

### Read-only ambient

| Global         | What it is                                                                         |
| -------------- | ---------------------------------------------------------------------------------- |
| `context`      | The reactive Queryable surface from Epic 16 — `context.activeWorkItem`, etc.       |
| `views`        | View component refs imported from the owning recipe, addressable by id.            |
| `cancellation` | A global `AbortSignal` for cooperative cancellation; pass into long-running calls. |

### Error classes (also globals, also catchable)

```ts
class WorkflowError extends Error {}
class TimeoutError extends WorkflowError {}
class SchemaExhaustedError extends WorkflowError {}
class ProviderUnavailableError extends WorkflowError {}
class PermissionDeniedError extends WorkflowError {}
class TargetMissingError extends WorkflowError {}
class CancelledError extends WorkflowError {}
class ReplayDriftError extends WorkflowError {}
```

The engine classifies every primitive failure into exactly one of these. Authors use
`instanceof` for branching. Anything outside the taxonomy is an engine bug.

## The Handle pattern

All primitives that fire something into the system return a typed handle:

```ts
type Handle<R = never> = R extends never
  ? {
      readonly id: string;
      update(view: View<never>): Promise<void>; // ui.show only
      dismiss(): Promise<void>;
    }
  : {
      readonly id: string;
      update(view: View<R>): Promise<void>; // ui.show only — same response type
      dismiss(): Promise<void>;
      readonly response: Promise<R>;
    };
```

The handle's `id` is **stable across replay**. The engine guarantees that the same call
site, same args, same journal entry → same `id`. This is what makes `handle.update(...)`
and `handle.dismiss(...)` durable: they reference the original side effect by id, and the
engine knows which system message / which child thread / which open question they refer
to.

### Two-await pattern is canonical

```ts
const banner = await ui.show(views.statusBanner({ message: "Working…" }));
// banner: Handle<never>
banner.update(views.statusBanner({ message: "Done." }));

const card = await ui.show(views.approvalCard({ summary }));
// card: Handle<ApprovalDecision>
const decision = await card.response;
if (!decision.approved) {
  /* … */
}
```

Two awaits in the response case is honest — the first journals the render, the second
journals the user's reply. They're different events; the user's reply can take hours.
We deliberately do **not** ship `ui.collect` / `child.request` / `thread.request` as
separate primitives — the unified `Handle<R>` model is the only one.

If you want a one-liner for the common ask-and-await pattern, the SDK ships pure-sugar
helpers in its prelude:

```ts
const decision = await askView(views.approvalCard({ summary }));
const summary = await askChild({ name: "Summarize", kickoffPrompt, responseSchema });
const decision = await askUser({ title, responseSchema });
```

Sugar only — they call the underlying primitive and `.then(h => h.response)`.

## The determinism contract — replay safety

> **This is the most important section of this doc.** The engine replays the workflow
> body from the top on every resume. Authors who break determinism break replay; the
> engine catches what it can but cannot catch everything.

### How replay works

Every primitive call writes a journal entry: `{ callId, argsHash, result, timestamp }`.
On resume:

1. The engine re-runs the workflow body from the top.
2. Each primitive call's `(callId, argsHash)` is compared against the journal.
3. **Matched:** return the recorded `result` synchronously without re-executing.
4. **Not journaled yet:** run the primitive live, journal the result, return it.
5. **Mismatched argsHash:** throw `ReplayDriftError` with the diverging call site.

`callId` is derived from the call's lexical position in the workflow body (file, line,
column) — not from a runtime counter. This is why **adding or removing primitive calls
between two existing ones is a workflow-version-incompatible change**: every call after
the insertion point shifts its lexical position.

### Rules authors must follow

**1. No ambient nondeterminism in workflow bodies.** Banned globals at workflow load
time (lint-checked; runtime throws if they leak in):

| Banned                         | Use instead                                          |
| ------------------------------ | ---------------------------------------------------- |
| `Date.now()`, `new Date()`     | `now()` global (journaled)                           |
| `Math.random()`                | `random()` global (journaled)                        |
| `crypto.randomUUID()`          | `uuid()` global (journaled)                          |
| `setTimeout`, `setInterval`    | `wait(ms)` global (journaled, suspend-aware)         |
| `fetch`                        | call from inside a `script` module — never inline    |
| `process.env`, `process.cwd()` | pass via `args` or read from `context`               |
| Module-level mutable state     | `let`/`var` at module level is refused by the linter |

**2. Imports are types-only.** Runtime imports change the module graph on replay — if a
dependency's behavior changes between original run and resume, replay diverges. Only
`import type { … } from "…"` is allowed in `.workflow.ts` files. The linter enforces
this; the loader refuses files that contain non-type runtime imports.

The single exception is `import { Schema } from "effect"` (and other allowlisted
pure-value modules). The allowlist is hard-coded; you cannot extend it project-locally.

**3. Schema decode at top.** `const input = Schema.decodeSync(Inputs)(args)` runs once,
deterministically, before any primitive calls. Don't decode lazily; don't decode in a
branch.

**4. Pure code between primitive calls.** Computation between `await agent(...)` and the
next primitive call must be deterministic given the prior journaled results. If you
branch on `now() > someThreshold`, that's fine (`now()` is journaled). If you branch on
a closure over a mutable outer variable, you'll diverge.

**5. Script handlers must be deterministic OR pinned.** The engine journals every
`scripts.<name>(args)` call's return value, so on replay you get the recorded result.
But if the _original_ run had a non-deterministic script (e.g. `fetch` from a 3rd-party
API that returns different data on each call), the recorded value is correct for replay
— what's wrong is making _decisions_ based on the assumption that re-running the script
would produce the same result. Authors should treat all `scripts.<name>(...)` results as
journaled facts, not re-derivable values.

For scripts that intentionally must run fresh (no replay), declare them with
`defineScript({ replay: "never", … })` — those calls are excluded from the journal and
always re-run on resume. Use sparingly; a `replay: "never"` call breaks replay
determinism for everything downstream of it.

### What the engine catches automatically

| Detected                                                                                         | When                      | Effect                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------- |
| Banned global usage (`Date.now`, etc.)                                                           | Lint + workflow load time | Workflow refuses to load                     |
| Non-type runtime imports                                                                         | Workflow load time        | Workflow refuses to load                     |
| Module-level mutable state                                                                       | Lint + load time          | Workflow refuses to load                     |
| `meta` referencing non-extractable values                                                        | Workflow load time        | Workflow refuses to load                     |
| Mismatched `argsHash` on replay                                                                  | Replay execution          | `ReplayDriftError` at the diverging site     |
| Primitive call after `cancellation` aborted                                                      | Runtime                   | `CancelledError`                             |
| Capability mismatch (call site references a tool whose `group` ref isn't in `meta.capabilities`) | Runtime, at the call site | `PermissionDeniedError` thrown and journaled |

### What the engine cannot catch

| Not detected                                          | Mitigation                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Branching on closure over a mutable outer variable    | Lint heuristic + determinism contract in docs                                                    |
| `script` modules that read from non-journaled sources | Documented contract; reviewer eye                                                                |
| Non-deterministic order in `parallel` callbacks       | The engine journals each thunk's result in input order; order-of-completion is not part of state |
| Hoisted top-level `var` that's later reassigned       | Lint refuses module-level `let`/`var`                                                            |

Authors who follow the rules get correctness for free. Authors who break them get loud,
specific errors at the boundary that broke (e.g. `ReplayDriftError` cites the file, line,
and a side-by-side hash of expected vs. observed args).

## Capability gating

`meta.capabilities` is a declarative allowlist that gates which globals are bound at
workflow-body-load time. A workflow that doesn't declare `"script"` has `script` as
`undefined` — calling it is an immediate `PermissionDeniedError` at the call site.

```ts
import { Schema } from "effect";
import { githubRead, releaseNotesWrite } from "@t3work/sdk/groups";

export const meta = {
  name: "release-notes-from-pr",
  capabilities: [
    "thread", // thread.send + handle responses
    "child", // child.spawn
    "user", // user.ask + user.notify
    "script", // scripts.*
    githubRead, // tool group ref (typed)
    releaseNotesWrite, // tool group ref (typed)
  ],
  // …
};
```

The capability list is a mixed array of two kinds of entries:

**Engine feature strings** — closed set, defined by the engine, won't grow project-locally:

| String       | Unlocks                                       |
| ------------ | --------------------------------------------- |
| `"thread"`   | `thread.send`                                 |
| `"child"`    | `child.spawn`                                 |
| `"user"`     | `user.ask`, `user.notify`                     |
| `"script"`   | `scripts.*` — the recipe's registered scripts |
| `"ui"`       | `ui.show` (auto-granted if recipe has views)  |
| `"workflow"` | `workflow()` (sub-workflow invocation)        |

**`ToolGroupRef`s** — typed references to tool groups declared via `defineToolGroup` (see
[§Tools](#tools)). Each ref unlocks every tool registered under that group. Built-in
groups ship in `@t3work/sdk/groups`; project-local groups live in `.t3work/groups.ts` or
the recipe.

TypeScript types `meta.capabilities` as `(EngineCapability | ToolGroupRef)[]` — wrong
feature strings caught at compile time; wrong group refs caught at compile time. The
loader extracts the array from `meta` and binds globals accordingly.

Globals not listed in either category — `agent`, `agent.task`, `parallel`, `pipeline`,
`phase`, `log`, `args`, `budget`, `wait`, `random`, `now`, `uuid`, `context`, `views`,
`cancellation`, and the error classes — are **unconditionally bound**. They have no
capability gate because their effects are either contained to the workflow run (timers,
journaled values), gated elsewhere (`agent` and `agent.task` consume the workflow's
declared model), or read-only.

Capabilities surface in the **pre-execution permission UI** the user sees before any
workflow with elevated capabilities runs. The UI reads each group ref's `label` and
`description` for human-friendly text; engine feature strings render via the engine's
own label table. This is the one place declarative JSON beats TS-as-config — the user
needs to see the request _before_ executing the code that would ask for it.

Nested workflows can declare a subset of the parent's capabilities but never a superset.
The engine intersects at invocation.

## Tools

Tools are the t3work capability surface — the verbs that read or mutate external state
(GitHub, Jira, the filesystem, the workspace). Workflows call them; views call them
indirectly through workflows. They are owned and dispatched by `T3workToolBroker` (see
[Epic 16 §Tools](./16-action-recipes.md#tools)) but in the Epic 25 engine they appear in
workflow bodies as **typed, namespaced callables** — never as strings.

### `defineTool` — declaration + implementation in one place

```ts
// @t3work/sdk/tools/github.ts — a built-in tool
import { Schema } from "effect";
import { githubWrite } from "@t3work/sdk/groups";

export const mergePullRequest = defineTool({
  id: "github.pull_request.merge", // broker dispatch key
  group: githubWrite, // capability classification (typed ref)
  args: Schema.Struct({
    id: Schema.String,
    adminOverride: Schema.optional(Schema.Boolean),
  }),
  result: Schema.Struct({ sha: Schema.String }),
  handler: async (args, ctx) => {
    const result = await ctx.github.pulls.merge({ pull_number: args.id /* … */ });
    ctx.log.info("merged", { sha: result.sha });
    return { sha: result.sha };
  },
});
//  ^ ToolRef<{ id: string; adminOverride?: boolean }, { sha: string }>
```

Project-local tools are authored the same way under `.t3work/recipes/<id>/tools/` or
`.t3work/tools/`. Declaration (`id` / `group` / `args` / `result`) and implementation
(`handler`) live in one file — no separate handler module.

### Tool groups — `defineToolGroup`

Groups classify tools for the user-facing permission UI. They are typed refs (not
strings) for consistency, just like tools and workflows:

```ts
// @t3work/sdk/groups.ts — built-in groups
export const githubRead = defineToolGroup({
  id: "github.read",
  label: "Read GitHub data",
  description: "View PRs, issues, branches, files. Cannot modify state.",
});
export const githubWrite = defineToolGroup({
  id: "github.write",
  label: "Modify GitHub",
  description: "Merge PRs, push branches, edit issues, dispatch workflows.",
});
//  ^ both are ToolGroupRef
```

The `id` is the unique string identifier (used for permission UI display, audit logs,
and as the broker-side classification). `label` and `description` are user-facing.
Group `id`s are globally unique within a project; the loader refuses duplicate
registrations with a clear error.

Groups live in three tiers, by ownership:

- **Built-in groups** in `@t3work/sdk/groups.ts` — covers integrations the SDK ships
  (`githubRead`, `githubWrite`, `jiraRead`, `jiraWrite`, `t3workThreadWrite`, etc.).
- **Project-local groups** in `.t3work/groups.ts`, registered via
  `defineProject({ groups: { … } })`. For project-wide novel consent semantics.
- **Recipe-scoped groups** declared inline in `recipe.ts` when only that recipe's tools
  use them.

### The `tools.*` global tree

Workflow bodies call tools through a namespaced global — no imports needed for
built-ins. The mapping from tool `id` to the namespace path is mechanical:
`github.pull_request.merge` → `tools.github.pullRequest.merge` (dot segments become
nested objects; snake_case → camelCase per segment).

```ts
// inside a .workflow.ts body
const { sha } = await tools.github.pullRequest.merge({ id: input.prId });
//                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ToolRef, directly callable.
//                    Args + return are fully typed.
```

ToolRefs are directly callable — there's no separate `tool(ref, args)` dispatcher. The
ref's `group` is checked against `meta.capabilities` at the call site; missing
capability → `PermissionDeniedError` thrown synchronously and journaled like any other
primitive failure.

The SDK ships an ambient `.d.ts` for the built-in tree so authors get full IntelliSense
without a project build step.

### Project-local tools via recipe registration

Project-local tools register on the recipe (or the project root) and appear in the
workflow under a recipe- or project-scoped namespace:

```ts
// .t3work/recipes/pr-review/tools/customAnalyze.ts
export const customAnalyze = defineTool({
  id: "pr-review.custom_analyze",
  group: prReviewRead,
  args: Schema.Struct({ pr: PrSchema }),
  result: Schema.Struct({ score: Schema.Number, findings: Schema.Array(Schema.String) }),
  handler: async (args, ctx) => {
    // …local analysis logic…
    return { score, findings };
  },
});

// .t3work/recipes/pr-review/recipe.ts
import { customAnalyze } from "./tools/customAnalyze.ts";

export default defineRecipe({
  id: "pr-review",
  tools: { customAnalyze }, // makes tools.recipe.customAnalyze available
  // …
});
```

```ts
// inside any workflow of pr-review
const analysis = await tools.recipe.customAnalyze({ pr });
//                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ typed via the recipe's tools declaration
```

Project-level tools follow the same pattern from `.t3work/project.ts` and appear under
`tools.project.*`.

### `ToolHandlerCtx`

The handler's second argument is a typed context the broker injects per call:

```ts
type ToolHandlerCtx = {
  readonly threadId?:  string;        // present when called from a thread-bound workflow
  readonly runId?:     string;        // present when called inside a workflow run
  readonly workspaceRoot: string;

  log: { info(msg, fields?): void; warn(…); error(…); };
  fetch: typeof fetch;                // HTTP

  workspace: {                         // file IO rooted at the run dir (sandboxed by path)
    readText(rel: string):  Promise<string>;
    writeText(rel: string, content: string): Promise<void>;
    exists(rel: string):    Promise<boolean>;
  };

  callTool: <I, R>(ref: ToolRef<I, R>, args: I) => Promise<R>;   // typed cross-tool dispatch

  // Integration clients injected by the broker based on the tool's group:
  github?: GitHubClient;               // when group descends from github.*
  jira?:   JiraClient;                 // when group descends from jira.*
  // …
};
```

The handler is plain async TypeScript — no Effect ceremony required for authors, even
though the broker itself is an `Effect.Service` under the hood. Integration-specific
clients are injected based on the tool's `group` so the handler doesn't have to thread
credentials manually.

### Sandboxing — symmetric with workflow bodies

- **Built-in tool handlers** (in `@t3work/sdk/tools/*.ts`) are host-trusted code, no
  sandbox.
- **Project-local tool handlers** are stage-1 trusted today (same status as project
  recipes and scripts — see [Epic 16 §Security: Two Stages](./16-action-recipes.md#security-two-stages)).
  Stage 2 sandboxes them via the same VM-isolation work that sandboxes workflow bodies:
  the handler's `ToolHandlerCtx` becomes the only API surface, ambient
  `fetch`/`fs`/`process` are stripped from `globalThis`.

The handler ↔ workflow-body sandboxing is deliberately symmetric: same stage-1 vs.
stage-2 plan, same injected-`ctx`-becomes-the-only-surface pattern. No new security
model needed for tools.

## Scripts

Scripts are the recipe-private cousin of tools: TS modules that take typed input and
return typed output, but **not** broker-registered, **not** capability-grouped, and
**not** addressable from other recipes. They are for recipe-internal utility work — fetch
a PR, parse a commit message, derive a release-notes section — that doesn't deserve a
broker-tool entry but does deserve type safety.

### `defineScript` — same shape as `defineTool`, minus the broker concerns

```ts
// .t3work/recipes/pr-review/scripts/fetchPr.ts
import { Schema } from "effect";

export const Inputs = Schema.Struct({ url: Schema.String });
export const Outputs = Schema.Struct({
  title: Schema.String,
  diff: Schema.String,
  base: Schema.String,
  head: Schema.String,
});

export default defineScript({
  inputs: Inputs,
  outputs: Outputs,
  handler: async (args, ctx) => {
    const res = await ctx.fetch(args.url);
    const body = await res.json();
    return { title: body.title, diff: body.diff, base: body.base, head: body.head };
  },
});
//  ^ ScriptRef<{ url: string }, { title: string; diff: string; base: string; head: string }>
```

No `id`, no `group` — scripts are scoped to the recipe that registers them; they have
no global identity. The `"script"` engine capability gates whether `scripts.*` is bound
at all, but it doesn't gate which scripts the workflow can call (that's already limited
by recipe ownership).

### Recipe registration and the `scripts.*` global

```ts
// .t3work/recipes/pr-review/recipe.ts
import fetchPr from "./scripts/fetchPr.ts";
import parsePrTitle from "./scripts/parsePrTitle.ts";

export default defineRecipe({
  id: "pr-review",
  scripts: { fetchPr, parsePrTitle }, // makes scripts.fetchPr / scripts.parsePrTitle available
  // …
});
```

```ts
// inside a workflow of pr-review — no imports needed
const pr = await scripts.fetchPr({ url: input.prUrl });
const parsed = await scripts.parsePrTitle({ title: pr.title });
//             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ fully typed
```

The `scripts.*` global tree is built per-workflow at load time from the launching
recipe's `scripts` registration. There is no project-level or global script tree — if
you need cross-recipe reuse, promote the script to a tool with a group.

### `ScriptHandlerCtx`

Strictly smaller than `ToolHandlerCtx` — no integration clients, no per-call `threadId`
beyond what the workflow's run provides:

```ts
type ScriptHandlerCtx = {
  readonly runId:         string;
  readonly workspaceRoot: string;

  log:   { info(msg, fields?): void; warn(…); error(…); };
  fetch: typeof fetch;
  workspace: {
    readText(rel: string):  Promise<string>;
    writeText(rel: string, content: string): Promise<void>;
    exists(rel: string):    Promise<boolean>;
  };
  callTool: <I, R>(ref: ToolRef<I, R>, args: I) => Promise<R>;   // typed cross-tool dispatch
};
```

Scripts can call tools (`ctx.callTool`) so the line between "a tool that does
project-specific work" and "a script that uses host tools" is the registration shape,
not the capability.

### Sandboxing

Same stage-1 / stage-2 plan as tool handlers. The `ScriptHandlerCtx` becomes the only
API surface at stage 2.

## Recipes and workflow references

A recipe imports workflow types via type-only imports and registers them as typed refs:

```ts
// .t3work/recipes/pr-review/recipe.ts
import type * as StartReview from "./actions/start-review.workflow.ts";
import type * as ApproveAndMerge from "./actions/approve-and-merge.workflow.ts";
import type * as RequestChanges from "./actions/request-changes.workflow.ts";

export const startReview = defineWorkflow<typeof StartReview>("./actions/start-review.workflow.ts");
export const approveAndMerge = defineWorkflow<typeof ApproveAndMerge>(
  "./actions/approve-and-merge.workflow.ts",
);
export const requestChanges = defineWorkflow<typeof RequestChanges>(
  "./actions/request-changes.workflow.ts",
);

export default defineRecipe({
  id: "pr-review",
  applicability: {
    /* … */
  },
  surfaces: ["project.dashboard.myWork", "thread.context"],
  defaultAction: startReview, // typed binding
  sidecarSection: defineSidecarSection({
    /* … */
  }),
  conversationCard: defineConversationCard({
    /* … */
  }),
});
```

`defineWorkflow<typeof Module>("./path")` returns a `WorkflowRef<Inputs, Outputs>` whose
types are inferred from the file's exported `Inputs`/`Outputs` schemas via the type-only
import. The type-only import doesn't pull the workflow body into the host module graph at
runtime — TypeScript strips it — so the body stays sandboxed in the engine's VM at
invocation time.

View code consumes workflow refs by typed variable, with `host` injected as a prop:

```tsx
// .t3work/recipes/pr-review/views/PrItem.tsx
import { approveAndMerge, requestChanges } from "../recipe.ts";

export const PrItem = ({ pr, host }: PrItemProps) => (
  <div>
    <Button onClick={() => host.run(approveAndMerge, { prId: pr.id })}>Approve and merge</Button>
    <Button onClick={() => host.run(requestChanges, { prId: pr.id, reason: "…" })}>
      Request changes
    </Button>
  </div>
);
```

`host.run<I, O>(ref: WorkflowRef<I, O>, args: I): Promise<O>` is typed end-to-end. Wrong
args is a compile error. Missing fields is a compile error. The return type is the
workflow's declared `Outputs`. For long-running workflows where the view needs a handle
(progress, cancellation), use `host.start(ref, args): RunHandle<O>` — same args, returns
a richer handle with `status$`, `cancel()`, and `.result: Promise<O>`.

There is no string-keyed action registry on the recipe; views fire workflows directly via
the imported ref. The recipe's `defaultAction` is the only binding the launcher needs
statically — it's what the Quick Starts card / `/<slashAlias>` selection runs.

Sub-workflow invocation from inside another workflow body uses the `workflow()` global
with a typed `WorkflowRef`:

```ts
// inside another .workflow.ts
import type * as Degraded from "./degraded.workflow.ts";
const degraded = defineWorkflow<typeof Degraded>("./degraded.workflow.ts");

// later in the body:
const result = await workflow(degraded, args); // typed
```

`workflow()` does not accept a string form. For dynamic dispatch, branch on the ref:
`const ref = condition ? workflowA : workflowB; await workflow(ref, args);`.

## Agents vs. workflows — the asymmetry

Agents and workflows live in different runtime worlds, deliberately. Agents are
**in-flight** — the LLM streams tokens to its provider in a single open connection;
suspending an agent mid-turn means killing and re-establishing that connection. Workflows
are **durable** — every primitive call is a journaled checkpoint; suspending a workflow
parks it cheaply and resumes it on the next external event.

This asymmetry shapes the surface each side gets:

| Capability                                              | Agent                     | Workflow                   |
| ------------------------------------------------------- | ------------------------- | -------------------------- |
| Spawn a child thread                                    | ✅                        | ✅                         |
| Fire-and-forget message to another thread               | ✅                        | ✅                         |
| Receive messages from other threads                     | ✅ (inbound on next turn) | ✅ (via `Handle.response`) |
| Blocking ask with schema-typed response                 | ❌                        | ✅                         |
| Escalate to user and await typed reply                  | ❌                        | ✅                         |
| Branch on typed errors with try/catch                   | ❌                        | ✅                         |
| Compose multiple LLM calls with intermediate transforms | partial (in one turn)     | ✅                         |

Agents get the simplified, fire-and-forget surface (`t3work.thread.start_child`,
`t3work.thread.send` with `kind: "notify"`). Anything more — request/response,
suspend-and-resume, user escalation — belongs in a workflow.

When an agent needs schema-typed output, it spawns a workflow that does the work and
returns the typed result via `thread.send` to the agent's thread on the next turn. The
agent reads it as a normal inbound message. The workflow does the suspension.

## Implementation phasing

This engine is not yet built. The current runtime is the forward-only step-list cursor in
`apps/server/src/t3work-recipeWorkflowRuntime*.ts`. The migration:

| Phase | Scope                                                                                                                                                                                                                                   | Status  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 25.1  | `.workflow.ts` file loader + `meta` static extractor + `defineWorkflow` / `defineTool` / `defineToolGroup` / `defineScript` SDK + ambient `tools.*` / `scripts.*` trees + ambient types                                                 | Planned |
| 25.2  | Durable-execution engine prototype: journal, replay, `argsHash`, `ReplayDriftError`                                                                                                                                                     | Planned |
| 25.3  | Inherited primitives: `agent`, `agent.task`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`; plus the journaled-value primitives `random`, `now`, `uuid`, `wait`, and the `script` / `tool` invocation primitives | Planned |
| 25.4  | Handle primitives: `ui.show`, `child.spawn`, `thread.send`, `user.ask`, `user.notify` (depends on the cross-thread messaging broker work catalogued in Epic 16)                                                                         | Planned |
| 25.5  | Determinism enforcement: lint rules, banned-global throws, capability gating at load time                                                                                                                                               | Planned |
| 25.6  | Migration tooling: legacy `recipe.json` + step-union → `.workflow.ts` conversion script                                                                                                                                                 | Planned |
| 25.7  | Retire the step-union runtime; remove `recipeWorkflowRuntime*` once all recipes migrated                                                                                                                                                | Planned |

The old and new engines run side by side until phase 25.7. A recipe declares which engine
it's authored against via its module extension (`recipe.json` → old engine; `recipe.ts`

- `*.workflow.ts` → new engine).

## Open questions

1. **VM isolation strategy.** Stage 1 trusts project code (current). Stage 2 needs real
   sandboxing — likely via `node:vm` + a frozen-realm pattern, or a worker thread with a
   tightly typed message channel. Decide before phase 25.2 ships.
2. **Journal storage.** Per-run journal lives in `runs/<run-id>/journal.jsonl` for MVP;
   long-term may move into the SQL-backed local cache from Epic 16. Append-only either
   way.
3. **`agent.task` model selection for cost discipline.** When `meta.model` declares a
   default and a single `agent.task` call wants a cheaper model, the per-call `model:`
   override should be a strict subset of the workflow's declared capability for that
   provider. Surface the rule in the lint.
4. **Cancellation semantics for `child.spawn` orphans.** When a parent workflow throws
   without explicitly dismissing a child handle, does the engine cascade-cancel the
   child? Default proposal: yes, on parent failure or cancellation, propagate
   `CancelledError` to all open handles' targets via `thread.cancelled` system messages.
5. **`view.update` schema-change semantics.** `handle.update(view)` for a handle with a
   response schema must take a `View<SameR>` — different response types require a new
   `show` + new handle. The lint enforces this; the type system also catches it.

## References

- [Epic 16: Action Recipes](./16-action-recipes.md) — recipe shape, discovery, surfaces,
  applicability, kickoff UX.
- [Epic 19: Workspace Miniapps](./19-workspace-miniapps.md) — View placements and the
  miniapp contract that `ui.show` renders against.
- [Epic 21: Context & Tool Catalog](./21-context-tool-catalog.md) — tool groups for
  capability gating via `ToolGroupRef`s in `meta.capabilities`.
- [Epic 24: Tiered Message Composition](./24-tiered-message-composition.md) — system
  message envelope and the three-author conversation model that workflow messages slot
  into.
- The Claude Code `Workflow` tool — the inspiration; this engine extends it with
  arbitrary script execution, child sessions, cross-thread messaging, user escalation,
  and capability gating.
