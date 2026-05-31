# Epic 16: Action Recipes

## Purpose

Action recipes are project-scoped, context-aware workflow launchers. They turn a blank
chat into a concrete, repeatable action that is visible in the UI before the user opens a
conversation.

A recipe is not a special one-off feature. It is the first consumer of a small set of
shared primitives that the rest of `t3work` automation, agent interaction, and UI
extensibility are also built on. Get the primitives right and recipes, custom dashboards,
conversation cards, and project-local automation all become the same system viewed from
different angles.

## Core Primitives

Everything in this epic is expressed in terms of four primitives. They are defined once,
in code, and reused everywhere. Avoid inventing recipe-specific parallels to any of them.

| Primitive    | What it is                                                                                                                                                                                                                                                                                                             | Owns                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **Context**  | A read-only snapshot of the world the agent and workflows read. Two depths: a light _render context_ used before launch, and a rich _full context_ available after launch.                                                                                                                                             | `packages/project-context` |
| **Tools**    | The single capability surface — the verbs that read or mutate `t3work` and external state. The _same_ surface is consumed by agent turns, workflow steps, and views, scoped by `allowedToolGroups`. See [Epic 21](./21-context-tool-catalog.md).                                                                       | `T3workToolBroker`         |
| **Workflow** | The core engine. Target: a TS-native, replay-based durable-execution engine (Epic 25) where workflows are plain async TypeScript functions and primitive calls are journaled. Legacy: a serializable, persisted, forward-only sequence of typed steps the host interprets. Both run side by side during the migration. | `packages/project-recipes` |
| **View**     | A code-based, interactive UI unit that mounts on any surface — the action list, a conversation message, a dashboard slot, a side panel. Action launchers and conversation cards are both Views. See [Epic 19](./19-workspace-miniapps.md).                                                                             | `@t3work/miniapp-sdk`      |

How they interact, in one line:

> A **surface** discovers **recipes** using a render **context** → the user launches one →
> the host builds the full **context**, materializes a **run**, and executes the recipe's
> **workflow** → workflow steps drive the agent, call **tools**, run scripts, and present
> **views**.

"Template" is not a fifth primitive. It is a lifecycle stage: a recipe as _authored_
(with code that derives values from context) versus _rendered_ (concrete values for one
launch). When this document says a recipe is a template, it means the authored form.

## Scope

The first implementation supports project-scoped recipes only. Personal recipes and
company-owned collections are later extensions of the same model, distinguished only by
where the plugin module lives (project workspace vs. home workspace vs. bundled app).

The MVP does not optimize for public-marketplace security. Project recipes are trusted
local code in the first stage; see [Security: Two Stages](#security-two-stages) for how
that evolves.

## Plugin Modules

A recipe is authored as a **TypeScript plugin module**, not a JSON manifest with embedded
expression strings. This is the concrete form of the "shared core primitives, code-based,
no heavy JSON schemas" principle.

```text
recipes/
  qa-test-plan/
    recipe.ts            # default-exports the recipe definition
    action.view.tsx      # a View used as the launcher (optional)
    workflow.ts          # the workflow, if not inlined in recipe.ts (optional)
    prompt.md            # static/templated prompt material (optional)
    files/               # templated payload files (optional)
      test-plan.md
    helpers.ts           # relative helper modules (optional)
    fixtures/            # redacted context fixtures for authoring/tests (optional)
      jira-story.context.json
```

`recipe.ts` default-exports a typed object. Metadata that used to be a template string is
now a plain function of context — fully type-checked, no custom expression language, no
`new Function` evaluator.

```ts
import { defineRecipe, defineWorkflow } from "@t3work/plugin-sdk";

export default defineRecipe({
  id: "qa-test-plan",
  version: "0.1.0",
  scope: "project",
  surfaces: ["workitem.detail.sidepanel"],

  // Metadata is derived from context in code, not via {{ }} expressions.
  displayName: (ctx) => `Create QA plan for ${ctx.workitem?.displayId ?? "selected work"}`,
  shortDescription: "Build a test matrix from current ticket context",
  icon: (ctx) => (ctx.workitem?.type === "Bug" ? "bug" : "clipboard-check"),
  rank: (ctx) => (ctx.workitem?.priority === "High" ? 90 : 50),

  // Visibility is just a predicate over the render context.
  visible: (ctx) =>
    ctx.workitem?.provider === "jira" &&
    (ctx.workitem.type === "Story" || ctx.workitem.type === "Bug"),

  // The launcher View. Defaults to a host-rendered card if omitted.
  view: "./action.view.tsx",

  // The workflow. May be inlined or referenced from ./workflow.ts.
  workflow: defineWorkflow({
    steps: [
      /* ... */
    ],
  }),

  // Capability scope for everything this recipe runs — agent, scripts, and views.
  allowedToolGroups: ["integration.read", "artifact.rw"],

  // Optional shorthand for keyboard-driven selection from the composer's `/` typeahead.
  // Defaults to `id` when omitted. See "Composer slash-command launchers".
  slashAlias: "qa-plan",
});
```

> **Implementation status.** Today recipes are still authored as `recipe.json` with `{{ }}`
> expression strings evaluated by `new Function` engines in both
> `t3work-projectRecipeDiscoveryVisibility.ts` and
> `t3work-projectRecipeDiscoveryTemplate.ts`. The TS-module form above is still the Phase 1
> target. Phase 1 is not complete until discovery moves from "parse JSON + eval strings" to
> "`import()` a typed module" and the expression-engine path is removed.

### Supported authoring subset

Recipe modules run server-side on the host Node runtime (Node 24+ for standalone/server;
the bundled Electron runtime on desktop). They must run under Node's built-in type
stripping — no compile/transpile step is shipped for project-local code.

Supported: ESM, type annotations, interfaces/type aliases, generics, `import type`,
relative imports to other recipe `.ts` files, and `node:` built-ins.

Out of scope for the MVP: decorators, `enum`, runtime namespaces, parameter properties,
CommonJS, tsconfig path aliases (`~/foo`, `@/foo`), and any package import that needs
`npm`/`bun install`. Views (`.tsx`) are the exception — they are compiled by the View
runtime, not type-stripped (see [Epic 19](./19-workspace-miniapps.md)).

Authoring rule:

```text
If the code would need TypeScript compilation to change runtime behavior,
it is out of scope for the MVP — except Views, which the View runtime compiles.
```

### Dependency policy

Recipe modules do not declare or install third-party packages. No `package.json` inside a
recipe, no per-project install step, no background dependency resolution. If a capability
is needed repeatedly, expose it as a **Tool** rather than a library import.

## Context: Reactive Queryable Surface

Context is the read substrate that every consumer of the recipe system reads — recipe
discovery (`visible(ctx)`, `displayName(ctx)`, `rank(ctx)`), Views, and workflow steps
(`script`, `agent`, `tool`) all bind the same model. It is not a recipe-specific concept.

This section defines the contract. Surfaces (next section) declare which context shapes
they expose; Discovery uses the contract to evaluate recipes; Views consume the same
queryables as component props; workflow steps consume a snapshot of the same contract at
step start.

### Surface-typed contexts

The context shape varies by surface. Each surface has its own typed context; recipes
declare which surfaces they apply to and TS narrows the `ctx` parameter accordingly:

```ts
type RenderContext =
  | DashboardBacklogContext // surface: "project.dashboard.backlog"
  | DashboardMyWorkContext // surface: "project.dashboard.myWork"
  | WorkItemDetailContext // surface: "workitem.detail.sidepanel"
  | ThreadContext // surface: "thread.context"
  | GithubPullRequestDetailContext // surface: "github.pullRequest.detail.sidepanel"
  | GithubPullRequestDiffSelectionContext
  | GithubReviewCommentContext;
```

A single-surface recipe gets a narrowed context type for free. A multi-surface recipe
narrows by `ctx.surface === "..."` inside `visible`/`displayName`/etc. TS prevents
accessing fields not present on the declared surfaces.

### Queryable contract

Collections in the context are never raw arrays — they are `Queryable<T>` values whose
methods the host backs with the appropriate runtime (Array methods at MVP, indexed SQL
queries at scale). Nested collections (e.g. a backlog item's references) are themselves
`Queryable<T>` all the way down.

```ts
type Queryable<T> = {
  readonly state: "idle" | "loading" | "ready" | "error";
  some(predicate?: (item: T) => boolean): boolean;
  where(predicate: (item: T) => boolean): Queryable<T>;
  count(): number;
  first(): T | undefined;
  // ...
};
```

One polymorphic type covers both eager and lazy collections — a loaded collection is just
a queryable in `state: "ready"`; a lazy one transitions through `idle` → `loading` →
`ready` as needed. Authors don't distinguish; the host owns load policy.

Recipes write code that reads naturally:

```ts
visible: (ctx) =>
  ctx.backlog.items
    .where((i) => i.visibleInCurrentView)
    .some((i) => i.references.some((r) => r.blockedBy != null));
```

The TS types prevent escape: `i.references` is `Queryable<Reference>`, not
`Array<Reference>`. Authors cannot slip into raw `Array.prototype` and break tracking.
Predicates passed to `.some`/`.where` are plain JS — the host traces field access through
them via Proxy.

### Pure functions, Proxy-traced reactivity

Recipes never subscribe to events. `visible` (and metadata derivers like `displayName` and
`rank`) are **pure functions of the context**:

```ts
visible: (ctx: RenderContext) => boolean | VisibilityResult; // preferred: sync, pure
visible: (ctx: RenderContext, api: ReadOnlyToolsApi) => Promise<boolean | VisibilityResult>; // escape hatch
```

**On high-churn surfaces** (`project.dashboard.backlog`, `project.dashboard.myWork`, and
the side-panel action list — anything that updates on every state change), `visible` must
be **synchronous**. A recipe returning a Promise on those surfaces is an authoring error
caught at load time. Async `visible` is reserved for low-churn detail surfaces. Any data
a recipe thinks it needs to fetch should instead arrive in the render context as a
pre-fetched lazy resource (the host loads it; the recipe reads `Queryable<T>` synchronously
with a `pending` visibility while it resolves).

What recipes cannot do: subscribe to events, mutate state, call write tools, depend on
values not in `ctx`.

The runtime makes re-evaluation cheap via **Proxy-traced access tracking**:

- On first evaluation, the host wraps `ctx` (and recursively, every queryable item the
  recipe descends into) in a Proxy that records every path the recipe reads.
- That recorded access set becomes the recipe's memoization key.
- When context changes, the host diffs the change set against each recipe's access set;
  only recipes whose access set intersects the change set re-evaluate.

For 1000 recipes × a search-box keystroke that touches one field, ~5-20 recipes actually
re-evaluate, not 1000. Same mechanism Solid/MobX/Vue reactivity use, applied at the
recipe-and-View boundary.

### Reactivity rule

> If a recipe needs to react to some piece of state, that state must be in the render
> context. Adding a new reactive dimension means adding a field to the render context —
> not giving recipes a subscription API. The render context is the contract.

### Lazy loading and visibility-while-loading

On surfaces where some collections aren't preloaded (e.g. backlog item references when
viewing the backlog list), accessing a `Queryable<T>` in `idle` state triggers an async
load, returns a sentinel result for the current evaluation (`false` / `0` / `undefined`),
and invalidates the dependency when data is ready. The visibility result can express
loading state to the UI:

```ts
type VisibilityResult =
  | boolean
  | { visible: boolean; pending?: boolean; rank?: number; reason?: string };
```

`pending: true` lets the action list show a skeleton or a faint indicator instead of
flickering recipes in and out as data resolves. Only recipes that actually touch lazy
resources pay any load cost, and that cost is shared across all recipes that touch the
same data.

### Backed by the local cache, not by request-keyed HTTP cache

The Queryable runtime is **backed by the existing local SQL persistence layer**, not by
URL-keyed HTTP caches. Both the server and the client (via the server) read from the same
relational store, so rich queries — joins, predicates, aggregates over thousands of items
— compose naturally:

- **Server side** ([apps/server/src/persistence/Layers/Sqlite.ts](apps/server/src/persistence/Layers/Sqlite.ts)
  via `effect/sql` + migrations under `persistence/Migrations/`) is the source of truth.
  Provider integrations (Atlassian, GitHub) sync into namespaced tables; the t3work-specific
  cache layer ([t3work-atlassian-backlog-cacheReadWrite.ts](apps/server/src/t3work-atlassian-backlog-cacheReadWrite.ts))
  already follows this shape.
- **Client side** consumes the same data via server queries and a thin reactive layer that
  subscribes to projection changes. No separate fetch-then-cache; queries are first-class.

`Queryable<T>.where`/`some`/`count` compile to SQL against the local store wherever a SQL
binding is available, and fall back to in-memory iteration otherwise (e.g. for tiny
in-memory derived collections). This is how nested predicates over thousands of items stay
sub-millisecond at scale.

### Reactivity flows through projection invalidation

Reactivity is **event-sourced**, reusing the existing orchestration-events / projection
pipeline. The flow:

1. A tool mutates state (e.g. a Jira ticket update).
2. The mutation lands in SQL; an event is emitted on the orchestration bus.
3. Projection pipeline updates derived tables.
4. The Queryable layer marks affected rows; subscribed consumers (recipe discovery, Views,
   open `collect-input` steps awaiting context-dependent inputs) are notified.
5. The Proxy-traced dependency layer re-evaluates only the consumers whose access set
   intersected the changed rows.

No polling, no stale-while-revalidate guessing, no full-context invalidation. The same
event-sourced model the runtime already uses for thread/message state extends to
recipe/View reactivity.

### Performance budgets

Recipes are evaluated against the published budgets:

- **Discovery (full pass, current surface, warm cache):** < 5 ms p95.
- **Single `visible(ctx)`:** < 100 µs typical. Anything above is a smell — usually a
  predicate iterating a raw collection that should be a queryable.
- **Per-change re-evaluation (typical state change):** < 1-3 ms — only recipes whose
  access set intersects the change.
- **High-churn input (search/filter typing):** caller debounces context update at
  50-150 ms. Discovery does not run per-keystroke.
- **Cold module load:** mtime-cached; one-time cost per process.

A recipe that breaks these budgets is logged as a warning in dev and surfaces in the
debug panel.

### Same model, three consumers

The Context contract is consumed identically by all three places that need data:

| Consumer                                            | Binding                                            | Reactivity                         |
| --------------------------------------------------- | -------------------------------------------------- | ---------------------------------- |
| Recipe discovery (`visible`, `displayName`, `rank`) | UI side, live context                              | Yes — Proxy-traced                 |
| Views (in conversation, dashboards, side panels)    | UI side, live context as props                     | Yes — field access is subscription |
| Workflow steps (`script`, `agent`, `tool`)          | Server side, **snapshot** of context at step start | No — one-shot per step             |

The query API and lazy-resource semantics are identical; recipe and View authors learn
one model. The only difference is that server-side workflow steps read against a snapshot
fixed for the step's lifetime — they don't re-run when data changes mid-step. For
long-running workflows that need to react to data changes mid-run, the runtime exposes
typed events (e.g. `collect-input` can resume on a tool-emitted event), not implicit
re-execution.

## Surfaces

```ts
type ActionRecipeSurface =
  | "project.dashboard.backlog"
  | "project.dashboard.myWork"
  | "workitem.detail.sidepanel"
  | "thread.context"
  | "github.pullRequest.detail.sidepanel" // planned
  | "github.pullRequest.diff.selection" // planned
  | "github.review.comment"; // planned
```

The live MVP surfaces are `project.dashboard.backlog`, `project.dashboard.myWork`,
`workitem.detail.sidepanel`, and `thread.context`. The dashboard split mirrors how the
rest of the system is already partitioned — the tool catalog uses separate
`t3work.backlog.*` and `t3work.my_work.*` namespaces ([Epic 21](./21-context-tool-catalog.md)),
and the React layer renders `ProjectDashboardBacklogView` and `ProjectDashboardMyWorkView`
as distinct pages. Each gets its own typed context; recipes that legitimately span both
declare both surfaces and narrow with `ctx.surface ===`.

Dot-namespacing is hierarchical for ranking and UI grouping purposes only; surface
matching is exact-string. There is no abstract `project.dashboard` parent.

The GitHub surfaces are reserved in the enum but not yet wired; they remain project-scoped
because the GitHub views are rooted in a project-linked repository resource. The next
planned expansion is first-class GitHub PR recipes on the PR detail page, diff selection
menu, and review comment threads.

## Profile-Aware, Not Profile-Name-Aware

The render and full context already include `profile`, so recipes branch on profile
_preferences_, never on profile identity.

Recipes and Views must not branch on `profile.id`, `profile.title`, or any assumed
built-in profile list. They branch on lower-level preference fields:

- `profile.communicationStyle.technicalDepth`
- `profile.communicationStyle.guidanceStyle`
- `profile.communicationStyle.brevity`
- `profile.surfaceDefaults`
- `profile.preferredArtifactKinds`
- `profile.defaultActionFamilies`
- `profile.defaultRecipeWeights`

The same recipe may vary all of these by profile: label and description, rank and
visibility, View copy and call-to-action tone, prompt instructions and expected output
shape, and which sections of a View expand first.

Examples for the same GitHub PR context:

- high technical depth + expert guidance → `Deep review this PR`, diff-heavy, risk framing
- guided density + release/deployment preference → `Explain what changed and what to test`,
  with change buckets, checks, and deployment cues first
- low technical depth + short brevity + summary-first → `Explain customer and rollout impact`

Project recipes may also rely on project-local conventions (PR body templates, required
release-note sections, deployment links and environment names, reviewer guidance).
Projects may ship starter profiles that produce these behaviors, but the engine observes
only the declared preference fields, never the starter profile names.

> Note the one deliberate asymmetry: `profile.defaultRecipeWeights` is keyed by recipe id,
> so a _profile_ may reference _recipes_ by id even though _recipes_ must not reference
> profiles by id. Profiles are app/project configuration; recipes are content.

## Discovery and Pre-Launch Rendering

Recipe actions render before any run exists. The dashboard and side panel need label,
icon, description, rank, and visibility while the user is still browsing. This uses the
light **render context** — the surface-typed reactive context defined in
[Context: Reactive Queryable Surface](#context-reactive-queryable-surface). Each surface
exposes its own typed shape (discriminated by `ctx.surface`); the common fields are:

```ts
// Illustrative — the real types are per-surface, discriminated unions.
// See the Context section for the queryable contract and per-surface shapes.
type RenderContextCommon = {
  surface: ActionRecipeSurface;
  project: ProjectRenderContext;
  profile: ProfileRenderContext;
  enabledSkillPacks: string[];
  // Surface-specific fields live on the surface-typed variants:
  //   DashboardBacklogContext  → { backlog: { items: Queryable<BacklogItem> }, ... }
  //   WorkItemDetailContext    → { workitem: WorkItemDetail, ... }
  //   ...
};
```

Discovery walks the project `recipes/` directory, loads each plugin module, filters by
surface, evaluates `visible`, and renders metadata. Failures are isolated:

- A recipe whose module fails to load or whose `visible`/metadata throws is dropped from
  the list — it never breaks the page or the other recipes.
- `visible` runs under a time budget (~1–2s); a timeout hides only that recipe.
- Diagnostics for dropped recipes surface in an advanced/debug surface, not inline.

`visible` should be fast and effectively side-effect-free. It may read context and call
read-only tools, but it must not perform writes or long IO. (See the binding note under
[Tools](#tools) for how pre-launch code gets a no-thread, read-only tool surface.)

### Bundled vs. project-local recipes

Bundled recipes (shipped with the app, enabled by skill packs) and project-local recipes
are the **same concept with different sources**. Bundled recipes are matched against the
render context by the recipe matcher; project-local recipes are discovered from the
workspace directory. A project-local recipe whose id matches a bundled one inherits the
bundled visibility/rank unless it declares its own. The long-term goal is a single
discovery path over a single recipe type, regardless of source.

## Conversation Participants

A conversation has **three message authors**: `user`, `agent`, and `system`. The third
author is what lets a workflow speak in the conversation as itself rather than ventriloquise
through `user` or `agent` messages — which is the bug that today's "workflow-injected
prompt rendered as a user message" pattern creates. System messages are first-class in the
conversation history; they are not a separate activity timeline.

```ts
type ConversationMessage = {
  id: MessageId;
  threadId: ThreadId;
  author:
    | { kind: "user" }
    | { kind: "agent"; agentId?: string }
    | { kind: "system"; source?: { workflowRunId: string; stepId?: string } };
  createdAt: string;

  // Two independent flags, not one audience enum.
  visibleToUser: boolean;
  visibleToAgent: boolean;

  body?: { text?: string; structured?: Record<string, unknown> };
  attachments?: ReadonlyArray<MessageAttachment>; // files, images, typed resources, more Views
  status?: "active" | "waiting-for-input" | "completed"; // mutable system messages
  updatedAt?: string;
};
```

The flags give you three useful cases:

| `visibleToUser` | `visibleToAgent` | Use                                                                     |
| --------------- | ---------------- | ----------------------------------------------------------------------- |
| ✓               | ✓                | shared turn (e.g. "Here's the test plan I prepared")                    |
| ✓               | ✗                | UX-only (e.g. "Workflow paused, awaiting your input")                   |
| ✗               | ✓                | hidden agent context (workflow-injected instructions, structured input) |

System messages are **mutable**. A workflow may update body/attachments/status until the
message reaches its terminal `completed` state. While it is still in progress, `status`
captures whether the message is actively progressing or paused on user input. This
subsumes the former `activity.phase: presented → updated → completed` pattern; the upsert
semantics live on the message itself.

### Attachments

All three author kinds can carry typed attachments. Attachments are how a message holds
content richer than plain text — files, images, structural typed context with its own
renderer, t3work artifacts, and additional interactive Views beyond the message's primary
body.

```ts
type MessageAttachment =
  | { kind: "file"; ref: BlobRef; mime: string; name?: string; size?: number }
  | { kind: "image"; ref: BlobRef; mime: string; name?: string; thumbnail?: BlobRef }
  | { kind: "resource"; ref: ResourceRef; snapshot?: ResourceSnapshot } // typed external context (Jira issue, GitHub PR, ...)
  | { kind: "artifact"; ref: ArtifactRef } // a durable t3work artifact (test plan, risk board, ...)
  | { kind: "view"; miniappId: string; props: Record<string, unknown> }; // an interactive View attached to this message
```

Each attachment kind has a host-registered renderer:

- **`file` / `image`** — standard blob attachments. Blobs live in workspace storage; the
  message carries a `BlobRef`, not inline bytes.
- **`resource`** — typed structural context (e.g. a Jira issue snapshot, a GitHub PR
  selection). Renders via the integration-provided component for that resource kind,
  using the resource-reference model from [Epic 13](./13-resource-references.md). This is
  the path for "structural context with special rendering."
- **`artifact`** — a reference to a durable t3work artifact ([Epic 08](./08-rich-artifacts.md)).
  Renders via the artifact's registered kind renderer.
- **`view`** — an interactive miniapp ([Epic 19](./19-workspace-miniapps.md)) attached to
  the message. Multiple `view` attachments may coexist with the message's primary body;
  actions on each round-trip through the workflow runtime as typed events. This is the
  path for "custom views inside a message" — for example, a checklist View next to a
  diff-preview View on the same system message.

User messages today already use a parallel attachment seam (composer context attachments
land as `resource` kind on the user message). The system author reuses the same
attachment infrastructure — there is no system-specific attachment list. The agent's
visible LLM context is built from each message's body plus the projected representation of
its attachments (resource snapshots, artifact summaries, file/image refs); the adapter
([Epic 20](./20-embedded-chat-and-handoffs.md)) owns that projection.

A message's "primary View" is just the first `view` attachment (or, equivalently, an
attachment whose role the renderer treats as the message's main card). The launch card
described in [Conversation-Native Launch UX](#conversation-native-launch-ux) is one such
view attachment on the workflow run's first system message.

**LLM-context mapping** is an adapter concern, not part of the conversation model. When the
t3 adapter builds an agent turn, it filters by `visibleToAgent` and projects each message
into the provider's native role using whatever the provider supports (Anthropic system
blocks, OpenAI developer role, or `user` with a tag). The conversation model commits to
"three authors, two visibility flags"; the projection rule belongs to the adapter.

### Additive seam

The three-author model is added without forking upstream message types. The seam is a
single optional field on `Message`:

```ts
// packages/contracts/src/model.ts  (already allowlisted)
export type Message = {
  // ...existing upstream fields
  t3workExt?: T3workMessageExt;
};

// packages/contracts/src/t3work-message-ext.ts  (new, prefix-compliant)
export type T3workMessageExt = {
  author?: { kind: "system"; source?: { workflowRunId: string; stepId?: string } };
  visibleToUser?: boolean;
  visibleToAgent?: boolean;
  attachments?: ReadonlyArray<MessageAttachment>; // file | image | resource | artifact | view
  status?: "active" | "waiting-for-input" | "completed";
  updatedAt?: string;
};
```

All rendering, persistence, and LLM-mapping logic lives in `t3work-`-prefixed files. The
upstream `Message` type gains one optional field. See [Epic 02 — Additive Extension
Pattern](./02-additive-architecture.md#additive-extension-pattern).

## Workflows

The workflow is the heart of the system. The original step-union JSON model below is
being replaced by a **TS-native, replay-based durable-execution engine** — workflows are
plain async TypeScript functions whose primitive calls are journaled and replayable. The
full engine specification lives in [Epic 25: Workflow Engine](./25-workflow-engine.md);
this section retains the recipe-facing parts (how recipes reference workflows, launcher
UX by workflow shape) and the legacy step-union types until phase 25.7 retires them.

The kickoff program was the first proof-of-concept slice of the legacy engine; it has
been absorbed into the unified step model below rather than kept as a separate mechanism.
The new engine continues that consolidation: a workflow body is one thing, called the
same way whether it powers a launcher card, a background task, or a sub-step of another
workflow.

```ts
type RecipeWorkflow = {
  version: 1;
  steps: RecipeWorkflowStep[];
};

type RecipeWorkflowStep =
  | { kind: "agent"; id: string; promptPath?: string; promptText?: string } // bootstrap live
  | { kind: "script"; id: string; module: string; input?: Record<string, unknown> } // live
  | { kind: "tool"; id: string; toolName: string; input?: Record<string, unknown> } // planned
  | { kind: "present-message"; id: string; message: SystemMessageSpec } // partial — see Step status
  | { kind: "collect-input"; id: string; request: InputRequest }; // partial — see Step status
// `agent.task` was previously catalogued as a legacy step kind but was never built;
// it lives only as the Epic 25 `agent.task` global. See §Background agent tasks.
```

`present-message` emits a system message (text, typed attachments, and/or one or more
Views) into the conversation. It absorbs the former `card` step: a "card" is just a
`present-message` whose attachments include a `view` kind at `conversation.inlineCard`.
The full payload — text body, files, images, resource snapshots, artifacts, and any number
of interactive Views — is the message's [attachments list](#attachments). Visibility flags
decide whether the user, the agent, or both see it.

`collect-input` pauses the workflow until a typed event arrives. The input may come from a
View action on a prior `present-message`, structured form data, or plain text. This
absorbs both the former `wait-for-kickoff-input` step (text reply) and the former
`await-card-action` step (View action event). The common "present a card and wait for a
button" pattern is now `present-message` followed by `collect-input`.

The former `run-interactive-agent` step is just an `agent` step. There is one step union,
not a separate kickoff union and workflow union.

### Deterministic workflows (no chat)

Not every recipe culminates in a conversation. A workflow that contains **no `agent` step**
is **deterministic**: it executes its `tool` / `script` / `present-message` /
`collect-input` steps without involving the LLM, and the launch path skips
thread/launch-card creation. The user sees the side effect (a filter applied, an artifact
written, a draft mutation queued), not a chat.

The canonical use case is an **inline filter** — a backlog View that renders chips like
"Show only unassigned", "Show all assigned to me", "Hide closed". Each chip is a recipe
whose workflow is a single `tool` step calling a view-state tool
(`t3work.backlog.set_assignee_filter`, etc.) with the chip's parameters. Clicking the chip
runs the workflow; the backlog re-filters; no conversation is created.

Authoring rule:

- If `workflow.steps` contains no `agent` step at any position, the launch is deterministic.
- The host detects this at launch time and selects the no-chat execution path: no thread
  bootstrap, no launch card, no kickoff prompt material. The workflow runs synchronously
  (or asynchronously for `script` steps) and reports completion via a transient affordance
  (toast, focus change, the visible state change itself) rather than an inserted message.
- `collect-input` and `present-message` steps are still valid in deterministic workflows
  (e.g., a confirmation dialog before a draft mutation). They render as modal/inline UI,
  not as conversation messages.
- A deterministic recipe's `view` placement is typically `action.inline` (see
  [Epic 19 — Placements](./19-workspace-miniapps.md#placements)) so the chip sits within
  the page's existing control chrome, not in a sidebar action list.

A recipe with even one `agent` step in its workflow stays on the conversational path —
the model does not split into two recipe types. It's the same recipe shape, with the
launch behaviour selected by the workflow's content.

### Launcher UX by workflow shape

The shell does not own a single launcher UX. Recipes surface through **sidecar sections**
([Epic 19 — Sidecar Sections](./19-workspace-miniapps.md#sidecar-sections)) — most
commonly the bundled "Quick Starts" section — and that section's View decides per-item
click behaviour based on the workflow's content:

| Workflow shape                                              | Click behaviour         | Result surface                                                                        |
| ----------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| No `agent` step (deterministic)                             | Execute immediately     | Visible state change + transient toast                                                |
| Has `agent` step + opening `collect-input` for kickoff text | Select → edit → send    | Chat thread, with the edited kickoff as the first user message                        |
| Has `agent` step, no kickoff `collect-input`                | Launch chat directly    | Chat thread opens, first agent turn fires                                             |
| Only `agent.task` (background-only)                         | Execute, capture result | Artifact ([Epic 08](./08-rich-artifacts.md)) or inline toast with the result; no chat |

The launcher detects the shape at click time and selects the row above. The same recipe
authoring shape (`recipe.ts`) covers all four; nothing on the recipe declares which UX it
wants.

In the legacy runtime, the launcher inspects the recipe's step list. In the Epic 25
engine, the same shape detection is performed by static analysis of the workflow body —
the loader checks whether the body contains any `agent()` calls (conversational), any
`agent.task()` calls (background), and whether the first primitive is a user-facing
prompt (`ui.show` / `user.ask`). The conceptual mapping (deterministic ↔ conversational ↔
background-only) is unchanged; only the detection mechanism differs.

Inline chips (the `action.inline` placement on the host page itself, e.g. a backlog
filter chip) use the deterministic row only — they cannot live on the chat path.

The same deterministic launcher path also backs sidecar context-menu actions declared by
`defineSidecarSection.itemActions` / `sectionActions`. A section action is just a small
single-step workflow launched through the existing `launchRecipeWorkflow` runtime; there
is no parallel sidecar-action executor.

These UX rules belong to the Quick Starts section (and any future recipe-launcher
section). Other sidecar sections — Recent Threads, Open Pull Requests, Status Widgets —
have entirely different click behaviours owned by their own View.

### Composer slash-command launchers

A recipe can also be selected from the composer by typing `/<slashAlias>`. The slash
typeahead is the keyboard-driven equivalent of clicking a Quick Starts card: the recipe
becomes the composer's pre-submit selection chip, the user keeps typing free-form
kickoff text, and submission funnels through the normal [Launcher UX by workflow shape](#launcher-ux-by-workflow-shape)
table — there is no second launch path.

#### Composer typeahead is a host primitive, not a recipe concern

The composer (today: `apps/web/src/components/chat/ChatComposer.tsx`) owns the typeahead
surface and the menu. Recipes are one of several contributor sources. The host's existing
discriminated union of menu item kinds is the extension point:

| Item kind                  | Source                                           | Selection effect                                                                                    |
| -------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `path`                     | `@` + workspace entries                          | Inserts a mention token                                                                             |
| `slash-command`            | `/` + hardcoded built-ins (`/model`, `/plan`, …) | Mode/model side-effects, typed range cleared                                                        |
| `provider-slash-command`   | `/` + `ServerProvider.slashCommands`             | Inserts the literal `/<name> ` so the provider runtime sees it                                      |
| `skill`                    | `$` + `ServerProvider.skills`                    | Inserts a `$skill` chip                                                                             |
| **`recipe-slash-command`** | **`/` + recipe catalog filtered by surface**     | **Clears the typed range; calls `setSelectedRecipe(recipe)` so the chip renders above the editor.** |

The recipe variant is the only one that **selects host state** rather than mutating the
editor's text. Everything else — token rendering, menu visuals, keyboard nav, fuzzy
ranking via `composerSlashCommandSearch.ts` — is reused as-is.

#### Discovery and filtering

Recipe slash items are sourced from the same `matchRecipes()` discovery the surrounding
sidecar uses (see [Discovery and Pre-Launch Rendering](#discovery-and-pre-launch-rendering)).
The composer hands the recipe catalog plus the current surface context (kickoff surface =
`project.dashboard.backlog` or `project.dashboard.myWork` depending on the dashboard tab;
in-thread = `thread.context`) and gets back the surface-applicable recipes in rank order.
Recipes whose `visible(ctx)` returns false are filtered out. This means the slash menu
shows exactly the same recipes the user would see as Quick Starts cards — no parallel
catalog, no separate visibility predicate.

The empty-query view (cursor immediately after `/`) shows all applicable recipes; typed
query narrows by `slashAlias` first, then `id`, then `title` — same scoring shape as
provider slash commands.

#### Menu grouping

`ComposerCommandMenu` already groups built-in vs. provider slash commands when both are
present. Recipe items add a third group, ordered last:

```
/  →  Built-in     /model, /plan, /default
      Provider     /commit, /init, …   (from selectedProvider.slashCommands)
      Recipes      /qa-plan, /risk-assessment, …   (applicable to current surface)
```

Group order is fixed; recipes do not interleave with built-ins so a project recipe cannot
shadow a host command in the visual list. (See "Namespace and collision rules" below for
how name collisions are blocked at registration time.)

#### `slashAlias` semantics

```ts
defineRecipe({
  id: "qa-test-plan",
  // ...
  slashAlias: "qa-plan", // optional; defaults to `id`
});
```

- Format: `[a-z0-9][a-z0-9-]*`. The leading `/` is implied by the trigger; aliases are
  stored without it.
- Default: when omitted, the recipe is reachable as `/<id>`. Recipes whose `id` is not a
  valid alias (uppercase, dots, etc.) get no implicit alias — they remain reachable only
  through the Quick Starts card.
- Per-surface scope: the alias is global within a project. Two recipes may share an alias
  only if their `surfaces` are disjoint; otherwise the merge step rejects the later one
  (see [Bundled vs. project-local recipes](#bundled-vs-project-local-recipes) for the
  precedence rule that decides which wins).

#### Namespace and collision rules

Aliases compete with host-owned commands. The catalog merge enforces precedence in this
order, refusing to register any later contributor that collides:

1. **Built-in slash commands** (`/model`, `/plan`, `/default`). Reserved; recipes cannot
   override.
2. **Provider slash commands** (`ServerProvider.slashCommands`). Reserved per-provider;
   recipes cannot override on a surface where that provider is currently selected.
3. **Bundled recipes** ([Bundled vs. project-local](#bundled-vs-project-local-recipes)).
4. **Project-local recipes**. A project recipe whose `id` matches a bundled recipe inherits
   the bundled `slashAlias` unless it declares its own (consistent with the existing
   visibility/rank inheritance rule).

Collisions surface in the same diagnostic channel as other recipe-load failures — the
recipe loads but its slash alias is suppressed; the Quick Starts card remains available.

#### Selection semantics — "select" not "launch on accept"

The slash menu's recipe row is **a selector**, not a launcher. On accept (Enter, Tab, or
click):

1. The host calls `applyPromptReplacement(rangeStart, rangeEnd, "")` to remove the typed
   `/<alias>` prefix from the editor — same pattern as the existing `/model` selection.
2. The host calls `setSelectedRecipe(recipe)` on the surrounding composer (the kickoff
   composer already owns this state for Quick Starts; the in-thread composer uses the
   equivalent seam).
3. The composer renders `TicketKickoffComposerSelectedRecipe` (or its in-thread
   equivalent) above the editor with the recipe's icon, title, and remove (`×`) affordance.
4. The user continues typing free-form text. On submit, the normal kickoff path runs:
   `text` becomes [`RecipeKickoffSubmission.text`](#kickoff-submission), the workflow
   launches per the shape table in [Launcher UX by workflow shape](#launcher-ux-by-workflow-shape).

This deliberately rebinds to the **existing pre-submit chip mechanism** rather than
introducing a new "launch-on-accept" branch. Consequences:

- One launch path. Click vs. slash both flow through `setSelectedRecipe → submit`. The
  workflow runtime does not need to know which entry point fired.
- Deterministic recipes still execute on submit (consistent with the shape table). A
  deterministic recipe selected via slash + an empty body simply submits to the synchronous
  execute path; no chat surface, same as clicking.
- Replacing the selection: typing another `/<alias>` while a chip is already mounted
  swaps the selection (drops the old chip, mounts the new one). The behaviour is
  intentional — the chip is composer state, not message attachment state.

#### In-thread composer

The slash menu is available wherever the composer is mounted. In-thread (post-launch)
slash-recipe selection is **scoped to the `thread.context` surface** — most recipes won't
match. When they do, submission spawns a new thread with the recipe as the kickoff (the
parent thread is unchanged). The runtime does not support "mid-thread recipe switch" —
one thread, one recipe (see [Conversation-Native Launch UX](#conversation-native-launch-ux)).

#### Implementation status

The composer-typeahead infrastructure (trigger detection, menu, item ranking, four-kind
discriminated union) is built. The kickoff composer
(`apps/web/src/t3work/t3work-TicketKickoffComposer.tsx`) currently **renders
`ComposerPromptEditor` without wiring `detectComposerTrigger` or
`ComposerCommandMenu`** — its placeholder advertises `/`, `@`, and `$` triggers that do
nothing. This is a bug independent of recipe slash commands: `$skill` and `@file` are
also broken in kickoff. The fix is to extract a shared `useComposerCommandMenu` hook from
`ChatComposer` and consume it from both composers. Recipe slash items can then be added
as a fifth item kind in one place.

Shipping order:

1. **Extract shared composer-menu hook**, restore `/`, `@`, `$` triggers in the kickoff
   composer. No recipe work involved.
2. **Add the `recipe-slash-command` item kind** and the `setSelectedRecipe` selection
   branch. Recipe items wired through `matchRecipes()`, no schema change yet — alias
   defaults to `id`.
3. **Add `slashAlias?: string` to `defineRecipe`**. Bundled recipes get explicit aliases;
   collision validation lands at this step.
4. **Surface filtering polish** — empty-query menu only shows applicable recipes; query
   matching prefers `slashAlias` over `id`.

#### Future: unifying with the command palette

[Epic 19 plans `defineCommandPaletteContributor`](./19-workspace-miniapps.md#sdk-surface)
for the Cmd+K command palette (`commandPalette.result` placement). The composer slash and
the command palette are both "type a name → invoke" surfaces; long-term they may share a
single contributor model. For MVP, `slashAlias` is a recipe-local field rather than a new
helper — the contributor unification is a Phase 5+ concern and orthogonal to shipping
recipe slash now.

### Background agent tasks

The interactive `agent` step opens or uses a conversation thread — the LLM's reply is a
visible message the user sees and (usually) the workflow continues on. Some workflows need
the opposite: an LLM invocation for **a specific, defined task** whose result feeds the next
step but never reaches a chat surface. Examples:

- summarize this PR diff into bullet points for a release-notes section
- classify this ticket as bug / chore / feature for routing
- generate three candidate test-plan headings from acceptance criteria
- extract a structured field set from a freeform description

In the **target engine (Epic 25)** these are the `agent.task` global — a background,
non-interactive LLM call whose typed result lives as a normal variable in the workflow
body:

```ts
const summary = await agent.task({
  prompt: `Summarize this diff:\n\n${pr.diff}`,
  schema: SummarySchema, // Effect Schema; typed return
  model: { provider: "anthropic-primary", model: models.anthropic.claudeHaiku45 },
});
// summary is Schema.Schema.Type<typeof SummarySchema>
```

Contract (carried over from the legacy step model and formalized in Epic 25):

- **No thread involvement.** No `thread.message.upsert`, no streaming to the conversation,
  no launch card update. The presence of `agent.task` does not turn a deterministic
  workflow into a conversational one.
- **Structured result.** The model is instructed to emit JSON conforming to `schema`;
  the engine parses + validates with Effect's decoder and returns the typed value.
  Schema-mismatch responses trigger a bounded retry with a corrective system message
  before failing as `SchemaExhaustedError`.
- **No step-result binding model needed.** In the replay-based engine, results are just
  variables in scope — no `resultBinding` / `$ref` indirection.
- **Cost discipline.** The optional per-call `model` override lets workflows route
  routine tasks to cheaper models without changing the user's default selection.
- **Failure handling.** Timeouts, provider errors, and schema-exhaustion surface as
  typed `WorkflowError` subclasses that `try`/`catch` can branch on.

In the **legacy step-union runtime** `agent.task` is unbuilt; recipes that need
background LLM work today fold the call into a `script` step that calls the provider
directly. New recipes should be authored against the Epic 25 surface.

### Execution model

**Legacy step-union runtime (current code):** the engine is stateless — a run is a
forward-only cursor over the persisted step list, with one suspension point at
`collect-input`. Resume continues forward from `nextStepIndex`; steps are never replayed.
This is what's running today in `apps/server/src/t3work-recipeWorkflowRuntime*.ts`.

> Be precise about what "stateless" buys in the legacy runtime: it enables _resume_, not
> _replay_. Stateful IO (filesystem, git, fetch, deriving artifacts) belongs in explicit
> `script` or `tool` steps that take serializable input and return serializable output,
> never in hidden engine state.

**Replay-based durable engine (target — Epic 25):** workflows are plain async TS
functions; every primitive call is journaled with a content hash of its arguments.
Resume replays the body from the top, returning recorded results until reaching the
next un-journaled call. This unlocks `try`/`catch`, branching, structured
request/response across threads, multi-hour suspension on user escalation, and typed
composition of workflows by typed reference. The full contract — including the
determinism rules authors must follow, the banned-global enforcement matrix, and
replay-drift error semantics — lives in
[Epic 25 §The determinism contract](./25-workflow-engine.md#the-determinism-contract--replay-safety).

The two engines run side by side during the migration: legacy `recipe.json` recipes use
the step-union runtime; new `recipe.ts` recipes whose workflows live in `.workflow.ts`
files use the replay-based engine. Phase 25.7 retires the legacy runtime once all
project-local recipes have migrated.

### Step status (legacy runtime)

- **Live:** the bootstrap `agent` step (the first kickoff turn); `script`; `present-message`
  in its "card" form (writes an activity payload today) and the matching `collect-input`
  in its "await-card-action" form.
- **Planned:** mid-workflow `agent` steps; `tool` steps (use a `script` step that calls
  tools for now); `present-message` for non-card messages (text-only and View-bearing system
  messages persisted as first-class messages via `t3workExt`); `collect-input` for text
  replies and structured form submissions (absorbing the former `wait-for-kickoff-input`).
- **Superseded by Epic 25:** every step kind above maps onto a global in the new engine
  (`agent`, `agent.task`, `script`, `tool`, `ui.show` for present-message, `Handle.response`
  for collect-input). Authors of new recipes should target the Epic 25 surface; the
  step-union shape stays documented here only until phase 25.7 retires it.

Per-step / per-call failures are isolated and recorded as activity in the run's timeline;
they do not crash the run or the page.

## Tools

Tools are one shared capability surface, not a recipe-specific API. They began as
agent-scoped tools (`T3workToolBroker` binds a per-thread set of `callTool`/`readResource`
capabilities for an agent turn). The same surface is consumed by:

- agent turns (today),
- workflow bodies — `script` / `tool` steps in the legacy runtime; in the Epic 25 engine,
  via the typed `tools.<group>.<name>(args)` ambient tree (see
  [Epic 25 §Tools](./25-workflow-engine.md#tools) for `defineTool` / `defineToolGroup`
  and how the typed-ref tree is constructed),
- Views (via the miniapp tool bridge).

A script receives the broker binding as `api.tools`; it does not get a second, parallel
tool API. `allowedToolGroups` on the recipe scopes that surface for everything the recipe
runs. The full catalog, tool classes (read / view-state / draft-mutation / external-
convenience), and the safety matrix live in [Epic 21](./21-context-tool-catalog.md).

```ts
type RecipeScriptApi = {
  tools: {
    call<T = unknown>(name: string, input?: Record<string, unknown>): Promise<T>;
    readResource(uri: string): Promise<unknown>;
  };
  workspace: {
    rootPath: string;
    recipePath: string;
    runPath?: string;
    readText(relativePath: string): Promise<string>;
    writeText(relativePath: string, content: string): Promise<void>;
    exists(relativePath: string): Promise<boolean>;
  };
  log: {
    info(msg: string, f?: object): void;
    warn(msg: string, f?: object): void;
    error(msg: string, f?: object): void;
  };
  fetch: typeof fetch;
};
```

Binding modes:

- **Thread-bound:** post-launch steps run with the run's thread binding.
- **No-thread (pre-launch):** discovery, `visible`, and View pre-render get a read-only
  binding (read tools and `readResource` only). This is why `visible` must stay
  side-effect-free.

> **Implementation status.** The broker now backs workflow `script` and `tool` steps and
> pre-launch `visible.ts` evaluation. Thread-bound recipe execution is filtered by
> `allowedToolGroups`; pre-launch bindings are further intersected with the read-only
> default (`integration.read`, `ui.render`). Project-local recipes with no declared
> `allowedToolGroups` get no tools. Bundled core recipes keep their explicit default grants
> from the bundled recipe registry for MVP compatibility.

## Views

A View is a code-based interactive UI unit. The launcher you click in the action list and
the interactive card inside a conversation are the **same primitive** mounted at different
**placements** — there is no separate "action MDX is pre-launch only" rule and no separate
card protocol. Views are specified in [Epic 19: Workspace Miniapps](./19-workspace-miniapps.md);
this section only states how recipes use them.

A recipe may declare a launcher View (`view: "./action.view.tsx"`). The same View model
provides conversation cards during a run. Relevant placements:

- `action` — the clickable launcher in the dashboard or side panel (pre-launch).
- `conversation.inlineCard` — an interactive card inside the run's conversation.
- `conversation.sidecar` — a side panel beside the conversation.

In-conversation Views are not a separate "card protocol": they are carried by the `view`
field of a system message (see [Conversation Participants](#conversation-participants)).
A workflow emits the system message — via a `present-message` step in the legacy runtime,
or via the `ui.show(view)` primitive in the Epic 25 engine — and the host renders the
referenced View at the message's placement.

Views receive context as props and use shell-provided components and the tool bridge. They
never start a chat by themselves; the shell owns click and launch behavior. A View action
(button, form submit, approval) round-trips through the workflow runtime as a typed event
— it does not mutate React state directly and, under [stage 2](#security-two-stages), does
not call tools directly from the renderer.

If a recipe declares no View, the host renders a default launcher/card from the recipe
metadata.

> **Implementation status.** Launcher Views render today via the MDX runtime
> (`t3work-recipeActionView.tsx`, client-side `@mdx-js/mdx` evaluate). Host-rendered
> conversation cards (`checklist | form | approval | artifact-preview | status`) render
> today from workflow `card` steps. Converging both onto the single miniapp View model and
> the typed-event action path is Phase 5.

## The Run

When a recipe is launched the host materializes a **run** — a working directory on disk.
The "recipe instance" is not a separate concept: it _is_ the run's on-disk directory plus
its persisted workflow state. There is no `ActionRecipeInstance` type distinct from the
run.

```text
runs/
  <run-id>/
    recipe/
      recipe.ts          # the resolved recipe module (or a snapshot of it)
      context.json       # concrete full context for this launch
      context.schema.json
      context-map.md
      prompt.md          # rendered
      files/             # rendered payload files
      workflow-state.json # legacy runtime: persisted forward-only cursor + step results
      journal.jsonl      # Epic 25 engine: append-only journal of primitive calls
                         # (per phase 25.2 — see Epic 25 §Open question 2)
```

The run directory is the **workflow runtime's** persistent record of a launch — a
durable working directory the runtime uses for audit, replay, and to give `script` /
`tool` steps a place to write outputs. **It is not an API surface the agent navigates.**
`recipe.ts` and `workflow.ts` are runtime-internal artifacts; the agent never sees them
and is never told to "follow" them.

The two engines share the run directory layout (`context.*`, `prompt.md`, `files/`) but
differ in their state file: `workflow-state.json` for the legacy step-cursor runtime,
`journal.jsonl` for the Epic 25 replay-based engine. A run uses one or the other based
on which engine the recipe targets.

Launch sequence (thread-first, so the user sees state immediately):

1. Create or focus the conversation thread immediately.
2. Insert a structured **launch card** into the timeline (a host-owned View; see below).
3. Build the full context for the project and optional work item.
4. Render templated metadata and files; materialize the run directory; write `context.json`,
   `context.schema.json`, and `context-map.md`.
5. Begin executing the workflow. Show progress on the launch card.
6. Only send the first agent turn when the workflow reaches an `agent` step.

### What the agent actually sees

When the workflow reaches an `agent` step, the workflow runtime constructs the agent's
turn material — it does **not** send a "read this directory" instruction. The agent's
view is built from three sources:

- **Prompt material** — the rendered content of the recipe's `prompt.md` (and any
  `promptText` / `promptPath` on the specific agent step) becomes prompt content
  delivered through the normal provider channel.
- **Context attachments** — `context.json` and any relevant resource snapshots ride as
  typed `MessageAttachment`s ([Conversation Participants — Attachments](#attachments))
  on a `system`-authored message with `visibleToUser: false, visibleToAgent: true`.
  Resource attachments use the typed renderer per [Epic 13](./13-resource-references.md);
  the JSON blob (`context.json`) attaches as a `file` or `resource` snapshot depending
  on size, with the projection rule owned by the t3-adapter (see [Tools](#tools)).
- **Tools** — the broker binding the agent received already exposes any read tools
  scoped by the recipe's `allowedToolGroups`. Recipes that genuinely need the agent to
  read or write run-local files declare it through tools (e.g., a `t3work.run.read_file`
  tool gated to that recipe), not through prose instructions.

The user never sees the bootstrap material in the conversation timeline — it lives on
a system message with `visibleToUser: false`. The first user-visible message in the
conversation is either the launch card (host-owned) or whatever the workflow's first
`present-message` emits.

**Anti-pattern:** do NOT emit a user-role message containing
"Follow the instantiated action recipe at &lt;path&gt;. Read recipe.ts first, then
prompt.md…". That string leaks workflow-runtime internals into the conversation,
ventriloquises through the user role, and exposes file paths the agent has no general
business reading. The runtime owns `recipe.ts` / `workflow.ts`; the agent owns the
task.

> **Implementation status.** Run-directory materialization is built. Each launch writes a
> concrete run under `runs/<workflowRunId>/recipe/` including `recipe.json`, `prompt.md`,
> `context.json`, `context.schema.json`, and `context-map.md`. The optional setup script
> (formerly `init.ts`) remains deferred until stage-2 sandboxing exists, because it is the
> riskiest ambient-code path.

### Full context contract

The full context is richer than the render context and is written to disk for both humans
and agents to read.

```ts
type ActionRecipeContext = {
  project: T3WorkProjectSnapshot;
  workitem?: ResourceSnapshot;
  selectedResource?: ResourceSnapshot;
  linkedResources: ResourceSnapshot[];
  sourceProject?: ExternalProjectSnapshot;
  artifacts: RichArtifactSummary[];
  recentRuns: RecipeRunSummary[];
  profile: T3WorkProfile;
  enabledSkillPacks: string[];
  memory: ProjectMemorySnapshot;
  capabilities: RecipeCapabilitySummary;
};
```

Each run writes `context.json` (concrete data), `context.schema.json` (JSON Schema for all
fields), and `context-map.md` (a short human/agent field guide). The schema is generated
from the `ActionRecipeContext` type in `packages/project-context`, not hand-maintained, so
it cannot drift from the type.

## Conversation-Native Launch UX

This section applies only to recipes whose workflow contains at least one interactive
`agent` step. Deterministic recipes and background-task-only recipes follow the no-chat
paths described in [Deterministic workflows](#deterministic-workflows-no-chat) and
[Background agent tasks](#background-agent-tasks); they do not create a thread or insert
a launch card.

A recipe click is a first-class workflow launch, not "fill the composer for me." Launch
switches the kickoff surface into normal conversation mode immediately.

The host-owned **launch card** is conversation-native state, distinct from author-defined
Views. Concretely it is the first system message of the run — a mutable system message
carrying a host-rendered launch View — inserted immediately on click, even while the
thread bootstrap or first context build is still pending. It shows at least:

- recipe id and version
- rendered title and short description
- source (`project-local` or bundled)
- selected surface and relevant work-item context
- current phase: `queued`, `creating-thread`, `bootstrapping-agent`, `running`,
  `waiting-for-input`, `completed`, `failed`
- optional reason/rank metadata when discovery provided it

The launch card updates in place (`status: active` → `waiting-for-input` → `completed`) as
the workflow advances. Subsequent workflow turns appear as additional system messages.

Launch is dynamic, decided by the workflow, not by a web-only special case: some recipes
auto-run the first agent turn immediately; others present a `collect-input` step and wait.
If the workflow pauses for input, the first user reply resumes the workflow path — the
reply is a normal `user` message in the conversation history, but workflow launch
semantics own the transition (it is not a plain `thread.turn.start`).

### Kickoff submission

The first user reply is a structured submission, not just a string:

```ts
type RecipeKickoffSubmission = {
  text?: string;
  attachments?: ReadonlyArray<RecipeLaunchAttachment>;
  structuredInput?: Record<string, unknown>;
};
```

A workflow paused on `collect-input` resumes through the recipe runtime with this
submission as workflow input. Any provider-specific translation from attachments to prompt
material happens after the workflow resumes, keeping kickoff and workflow one continuous
host-owned system.

> **Implementation status.** The launch card, string/text kickoff, and `collect-input`
> resume path are live. Attachment-backed kickoff submissions and structured kickoff
> payloads remain planned.

## Security: Two Stages

Project-hosted code (recipe modules, scripts, Views) is powerful. The model evolves in two
deliberate stages; both [Epic 16](./16-action-recipes.md) and
[Epic 19](./19-workspace-miniapps.md) share this framing.

**Stage 1 — Trusted (current).** Project recipes are trusted local code. Modules are loaded
with normal `import()`, scripts may use `node:` built-ins and `fetch` directly, and Views
are evaluated client-side. This is acceptable because, in the MVP, recipe code is authored
or reviewed by the project owner on their own machine.

**Stage 2 — Sandboxed (planned).** Project-hosted code runs with **no ambient
capabilities** — no direct filesystem, network, process, or React/DOM access. Everything
goes through host-injected APIs: the `T3workToolBroker` for tools, structured props for
data, and the typed-event path for View actions. Isolation is enforced by a worker/isolate
boundary (scripts) and a sandboxed iframe-equivalent (Views).

Design discipline to adopt **now**, while in stage 1, so stage 2 is "remove the escape
hatches" and not a rewrite:

- Route every capability through the injected `api.*` surface even though raw access still
  works. Do not let new recipes reach for `node:fs`/`fetch` when a tool exists.
- Make View actions emit typed events the workflow runtime handles, rather than calling
  tools from the renderer.
- Keep `allowedToolGroups` as the single enforcement point; it is inert in stage 1 but is
  exactly what stage 2 enforces.

Manifest/declared permissions should be shown before first enablement of any
project-hosted code.

## Agent-Created Recipes

Agents may offer to create a new project recipe after a workflow succeeds, or on direct
user request ("save this as a recipe"). Recipe authoring is itself a workflow — the
**`create-recipe` recipe** — built on the same primitives the agent is being asked to
extend. It is the canonical end-to-end example of the architecture working.

### The data contract the agent reads

When writing a recipe, the agent needs to know which surfaces exist, what fields live in
each surface's context, which queries are available, which tools the recipe may call, and
which Views can be referenced. The contract is the **TypeScript types**, exposed three
ways for whichever consumer prefers which form:

- **Generated `.d.ts` per surface** — the source of truth. `@t3work/plugin-sdk` exports
  `DashboardBacklogContext`, `WorkItemDetailContext`, etc. When the agent writes a
  `recipe.ts`, TypeScript checks every field access against the real context type. A wrong
  field is a compile error before runtime.
- **`context.schema.json`** — JSON Schema mirror of the same types, generated from the TS
  definitions in `packages/project-context`. For tools and agents that prefer schema over
  TS.
- **`context-map.md`** — short human/agent field guide. Which fields exist on the chosen
  surface, which are eager vs. lazy, which expose query methods, with one-line
  descriptions and an example call.

The same generated pipeline covers **Tools** (`@t3work/plugin-sdk` exports a typed
registry, autocomplete shows what's available) and **Views** (typed miniapp registry — a
recipe's `view:` reference is type-checked against the surface's context).

### The `create-recipe` workflow

A small, declarative workflow built from the unified step union — and itself a useful
proof that the architecture composes end-to-end:

```ts
// recipes/create-recipe/recipe.ts (bundled)
export default defineRecipe({
  id: "create-recipe",
  surfaces: ["thread.context"],
  // ...
  workflow: defineWorkflow({
    steps: [
      {
        kind: "collect-input",
        id: "ask-surface",
        request: {
          /* "which surface should this recipe appear on?" */
        },
      },
      {
        kind: "script",
        id: "gather-authoring-context",
        module: "./gather-authoring-context.ts",
        // assembles: surface's context.d.ts, allowed tool catalog,
        //   relevant existing recipes as exemplars, context-map.md
      },
      {
        kind: "agent",
        id: "draft-recipe",
        // prompt: write a recipe.ts using the assembled authoring context
      },
      {
        kind: "script",
        id: "validate",
        module: "./validate.ts",
        // type-checks + runs the additive guard against the draft
      },
      {
        kind: "present-message",
        id: "preview",
        message: {
          /* shows the draft + diff; carries a "Save" view */
        },
      },
      {
        kind: "collect-input",
        id: "confirm-save",
        request: {
          /* awaits the Save view action */
        },
      },
      {
        kind: "script",
        id: "save",
        module: "./save.ts",
        // writes recipes/<id>/recipe.ts and any helpers
      },
    ],
  }),
  allowedToolGroups: ["recipe.author", "artifact.rw"],
});
```

If this workflow runs end-to-end, the architecture has paid for itself: it exercises the
unified step union, system messages with embedded Views, the shared tool surface, the
materialized run directory, and the additive-guard discipline — all on the same primitives
described in this epic.

### The `edit-plugin-module` recipe

`create-recipe` writes new plugin modules. Its peer `edit-plugin-module` edits existing
ones. It is the **single canonical AI-edit entry point** invoked by every "Edit this…"
affordance in the UI — recipe context menus, sidecar section context menus, and any
future Edit-this surface ([Epic 19 — Context menus](./19-workspace-miniapps.md#context-menus)).

Shape:

1. **Input**: a target source path plus the kickoff customization (what change the
   user wants).
2. **Script step**: reads the target file, inspects which `define*` helper it exports,
   and selects the appropriate authoring guidance to inject into the agent's prompt
   (falling back to manifest guidance for legacy project-local `recipe.json` items).
3. **Agent step**: writes the full updated source into a run-local draft artifact using
   the targeted guidance.
4. **Present-message + collect-input**: shows the proposed diff as a `view` attachment,
   awaits explicit approval.
5. **Script step**: writes the approved draft back to disk.

One recipe handles every `define*` kind. Splitting prompt material into multiple
referenced files (`./prompts/edit-recipe.md`, `./prompts/edit-section.md`, etc.) is the
right move once per-kind guidance grows beyond what fits cleanly in one prompt — same
recipe, multiple prompt references picked by the script step.

The same workflow also backs the **"Customize…"** context-menu action used for
_structured / destructive_ operations (revert-to-bundled, reset overrides, change tool
grants, etc.). There are intentionally no ad-hoc confirmation dialogs in the UI — every
destructive customization routes through this guided workflow's preview + approval steps.

### Default behavior

- **Offer first**, never silently create. The agent triggers the `create-recipe` workflow
  with an explicit user confirmation; it does not write recipe files in the background.
- Save under the current project `recipes/` directory as a `recipe.ts` plugin module.
- Include a redacted fixture from the successful context for tests and future authoring.
- Reference the `context.schema.json` fields the module uses (the generated TS types are
  the binding contract).
- Prefer small reusable files over one large prompt.

Example offer:

```text
This workflow is repeatable. Create a project action recipe named "QA smoke plan"?
```

A malformed agent-written module is isolated by discovery (it is dropped, with diagnostics)
rather than breaking the project. Personal scope and company collections come after the
project recipe format proves stable.

## Managed Workspace Layout

Project recipes live next to project data:

```text
<managed-project>/
  project.json
  recipes/
    qa-test-plan/        # a recipe plugin module
  runs/
    <run-id>/
      recipe/            # the materialized run (the "instance")
  documents/
  cache/
  memory/
```

Bundled recipes from skill packs may be referenced or copied into project scope when a
project is created. Project-local recipes are the editable source of truth for the MVP.

## Implementation Status Summary

| Area                                                                                                                             | Status                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Project-local discovery + bundled matching                                                                                       | Built                                                                                                                       |
| Visibility (predicate + script, timeout, isolation)                                                                              | Built (via `recipe.json` + expression engine)                                                                               |
| TS-module authoring (`recipe.ts`), retire expression engine                                                                      | Planned (Phase 1 target; current engine still active)                                                                       |
| Unified workflow step union; kickoff absorbed                                                                                    | Built (legacy runtime; retired in phase 25.7)                                                                               |
| Workflow runtime: bootstrap agent, card, await-card-action, script                                                               | Built (legacy runtime; superseded by Epic 25 primitives)                                                                    |
| Workflow runtime: mid-flow agent, tool, present-message, collect-input                                                           | Built (legacy runtime; superseded by Epic 25 primitives in phase 25.4)                                                      |
| Three-author conversation model + `t3workExt` seam (system messages, view-in-message)                                            | Built                                                                                                                       |
| Shared tool surface for scripts/steps via broker; enforce `allowedToolGroups`                                                    | Built                                                                                                                       |
| Deterministic workflows (no-agent workflows skip thread/launch-card) + `action.inline` placement                                 | Built (tool-step no-chat path; backlog inline chip wired)                                                                   |
| `agent.task` step (background non-interactive LLM call) + step-result binding model                                              | Subsumed by Epic 25 `agent.task` global; step-result binding obsoleted by replay-based engine (results are scope variables) |
| Sidecar sections + `defineSidecarSection` SDK + composition model + remove hardcoded kickoff aside                               | Built (sections + composition + shell menus + declared deterministic actions)                                               |
| Composer slash-command launchers for recipes (`slashAlias` + `recipe-slash-command` item kind)                                   | Planned (precondition: extract shared composer-menu hook so kickoff wires `/`, `@`, `$` at all)                             |
| `define*` SDK surface (per-placement helpers, no generic primitive, multi-placement via exports)                                 | Planned (Phase 5 — ships alongside the placements it covers)                                                                |
| Run-directory materialization, `context.json`/schema/map                                                                         | Built                                                                                                                       |
| Setup script (formerly `init.ts`)                                                                                                | Deferred until stage-2 sandbox                                                                                              |
| Views unified on miniapp model; typed-event action path                                                                          | Planned (Phase 5)                                                                                                           |
| `Queryable<T>` contract (Array-backed at MVP)                                                                                    | Planned (Phase 2 — needed by unified steps)                                                                                 |
| `Queryable<T>` runtime: SQL-backed + signals (Signia / equivalent); projection-driven invalidation                               | Planned (Phase 6 — scale tier)                                                                                              |
| Agent-discovery types pipeline: generated `.d.ts` + `context.schema.json` + `context-map.md`                                     | Built                                                                                                                       |
| `create-recipe` recipe (canonical end-to-end workflow proof)                                                                     | Built                                                                                                                       |
| `edit-plugin-module` recipe (single canonical AI-edit entry point; backs "Edit this…" now and remains the base for "Customize…") | Implemented for "Edit this…" (Phase 5c); structured customize flows remain deferred                                         |
| Stage-2 sandboxing                                                                                                               | Planned, parallel track                                                                                                     |
| **Epic 25 — `.workflow.ts` loader + `meta` static extractor + `defineWorkflow` / `defineTool` / `defineToolGroup` / `defineScript` SDK + ambient `tools.*` / `scripts.*` trees** | Planned (25.1)                                                                              |
| **Epic 25 — Durable-execution engine: journal, replay, argsHash, `ReplayDriftError`**                                            | Planned (25.2 — foundational rewrite)                                                                                       |
| **Epic 25 — Inherited and ambient primitives: `agent`, `agent.task`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`, `random`, `now`, `uuid`, `wait`, `scripts.*`, `tools.*`** | Planned (25.3)                                                                  |
| **Epic 25 — Handle primitives: `ui.show`, `child.spawn`, `thread.send`, `user.ask`, `user.notify`**                              | Planned (25.4 — depends on cross-thread messaging broker work)                                                              |
| **Epic 25 — Determinism enforcement: lint rules, banned-global throws, capability gating at load time**                          | Planned (25.5)                                                                                                              |
| **Epic 25 — Migration tooling: legacy `recipe.json` + step-union → `.workflow.ts` conversion**                                   | Planned (25.6)                                                                                                              |
| **Epic 25 — Retire legacy step-union runtime (`recipeWorkflowRuntime*`)**                                                        | Planned (25.7 — after all recipes migrated)                                                                                 |

## Implementation Notes

- `packages/project-recipes` owns recipe definitions, the workflow engine, discovery, and
  visibility evaluation.
- `packages/project-context` owns context schemas, the `Queryable<T>` contract, and the
  generated agent-discovery artifacts (`.d.ts` per surface, `context.schema.json`,
  `context-map.md`). All three are generated from the canonical TS types — never
  hand-maintained.
- `@t3work/plugin-sdk` (to be introduced) owns `defineRecipe`/`defineWorkflow` and the
  plugin-module contract; `@t3work/miniapp-sdk` owns Views.
- `T3workToolBroker` (`apps/server`) is the single tool surface for agents, scripts, and
  Views. Mutations through it emit events on the existing orchestration bus.
- **The Queryable runtime is backed by the existing local SQLite persistence layer**
  ([apps/server/src/persistence/Layers/Sqlite.ts](apps/server/src/persistence/Layers/Sqlite.ts)
  via `effect/sql` + migrations under `persistence/Migrations/`). Provider sync writes
  into namespaced tables (the t3work-Atlassian backlog cache at
  [t3work-atlassian-backlog-cacheReadWrite.ts](apps/server/src/t3work-atlassian-backlog-cacheReadWrite.ts)
  is the existing template). Recipe/View queries run against this store, not against
  HTTP-keyed caches.
- Reactivity reuses the existing orchestration-events / projection pipeline for
  invalidation. The client-side reactive layer (likely [Signia](https://github.com/tldraw/signia)
  or equivalent — Solid-store standalone and MobX are alternatives) subscribes to projection
  changes and drives recipe/View re-evaluation through the Proxy-traced dependency layer.
  TanStack Query and similar URL-keyed caches are explicitly **not** the model.
- `apps/web/src/t3work` renders recipe actions and launch cards; it must not evaluate
  provider-specific context directly.
- Thread bootstrap and the special recipe launch message live in the t3 adapter / server
  workflow runtime ([t3work-recipeWorkflowRuntime.ts](apps/server/src/t3work-recipeWorkflowRuntime.ts)).
