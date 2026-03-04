# Plan Mode Deep Dive

## Goal

Understand how the three providers expose:

- planning / read-only execution modes
- structured plan updates
- structured user-input / question prompts
- response plumbing needed for a provider-agnostic adapter layer

Providers covered:

- Codex App Server
- Claude Agent SDK / Claude Code
- Cursor ACP

---

## Existing T3 Code groundwork

Current repo groundwork already exists in these places:

- `EVENTS.md`
- `packages/contracts/src/providerRuntime.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts`
- `apps/server/src/provider/Layers/CursorAdapter.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`

Canonical runtime events already modeled:

- `turn.plan.updated`
- `content.delta` with `streamKind: "plan_text"`
- `user-input.requested`
- `user-input.resolved`
- `request.opened`
- `request.resolved`

This is a good base, but provider coverage is uneven:

- Codex: strong native support for both structured plans and structured user questions.
- Claude: native plan mode exists, but plan updates are mostly implicit via tool/message stream; user questioning appears tool-based rather than a dedicated runtime event.
- Cursor ACP: native plan mode exists, but current ACP surface appears to expose neither structured plan updates nor structured ask-user prompts in the same way as Codex.

---

## Provider 1: Codex App Server

### What exists natively

Codex has the richest first-class support for this feature set.

### Real local session evidence

The local Codex rollout file confirms at least one important distinction:

- session metadata explicitly records collaboration mode as plan via `turn_context.payload.collaboration_mode.mode = "plan"`
- final plan handoff is emitted as a normal assistant message containing a `<proposed_plan>` block

From the sampled rollout file, I did **not** find raw `event_msg.plan_update` / `event_msg.plan_delta` records, which suggests either:

- this particular session never emitted incremental structured plan updates, or
- the desktop rollout file persists a higher-level message projection rather than every low-level app-server event

That means the app-server protocol still supports native structured plan events, but local rollout files should not be assumed to contain every transport-level plan artifact.


Native surfaces confirmed from upstream docs/source:

- collaboration mode with plan behavior
- `turn/plan/updated`
- `item/plan/delta`
- `item/tool/requestUserInput`
- `serverRequest/resolved` cleanup / completion notification for user input
- `request_user_input` tool in core/runtime

Evidence inspected:

- upstream `codex-rs/app-server/README.md`
- upstream `codex-rs/app-server-protocol` schemas
- upstream `codex-rs/core/src/tools/handlers/request_user_input.rs`
- upstream `codex-rs/core/templates/collaboration_mode/plan.md`

### Semantics

#### Plan mode

Codex plan mode is not just “tool execution denied”. It has explicit behavioral guidance and explicit planning outputs.

Two distinct plan surfaces exist:

1. **Structured plan state**
   - `turn/plan/updated`
   - payload contains:
     - optional `explanation`
     - `plan: Array<{ step, status }>`
   - statuses are `pending | inProgress | completed`

2. **Plan text stream**
   - `item/plan/delta`
   - useful for rendering streaming plan prose / bullet lists before or alongside structured state

This maps very cleanly to our canonical events:

- `turn/plan.updated` -> `turn.plan.updated`
- `item/plan/delta` -> `content.delta(plan_text)`

#### Structured user questions

Codex has a dedicated `request_user_input` capability.

Server request:

- `item/tool/requestUserInput`

Shape characteristics from upstream protocol/docs:

- 1–3 questions
- each question has:
  - prompt text
  - stable id
  - required options
- response carries answers per question
- freeform notes are supported in UX and answer model

Important nuance:

- upstream handler currently requires non-empty options for every question
- Codex TUI also supports an optional freeform note / text alongside selected options
- pending question requests are turn-scoped and cleaned up on turn completion/interruption

### Why Codex is the reference model

Codex should be treated as the reference shape for our provider-agnostic abstraction because it already matches the desired UI:

- explicit plan lifecycle
- explicit multi-question prompt flow
- explicit answer submission
- explicit pending/resolved bookkeeping

### Adapter implications

For Codex, the provider adapter layer should stay close to native protocol:

- keep `turn.plan.updated`
- keep `content.delta(plan_text)`
- map `item/tool/requestUserInput` to `user-input.requested` and `request.opened`
- map answer completion / cleanup to `user-input.resolved` and `request.resolved`

---

## Provider 2: Claude Agent SDK / Claude Code

### What exists natively

Claude has an explicit plan permission mode:

### Real local session evidence

The sampled Claude session file provides concrete payloads for both key plan-mode tools:

1. `AskUserQuestion` appears as a normal assistant `tool_use` block with input like:

```json
{
  "type": "tool_use",
  "name": "AskUserQuestion",
  "input": {
    "questions": [
      {
        "question": "What does 'adding profiles to canvas' mean to you? What should profiles enable in canvas?",
        "header": "Scope",
        "options": [
          { "label": "Organize by profile", "description": "..." },
          { "label": "Profile icon bar in canvas", "description": "..." },
          { "label": "Per-profile canvas settings", "description": "..." },
          { "label": "All of the above", "description": "..." }
        ],
        "multiSelect": false
      }
    ]
  }
}
```

2. `ExitPlanMode` also appears as a `tool_use` block, with a long-form `plan` string payload containing the finalized implementation spec.

That gives us two strong adapter conclusions:

- Claude user-input prompting is definitely tool-based and structurally parseable.
- Claude final plan handoff is tool-based too, not necessarily a dedicated transport event like Codex `turn/plan/updated`.

### Concrete adapter mapping from transcript evidence

Recommended Claude mapping based on real session data:

- `tool_use.name === "AskUserQuestion"` -> `user-input.requested`
- user answer submission / tool result -> `user-input.resolved`
- `tool_use.name === "ExitPlanMode"` with `input.plan` -> final plan handoff event or synthesized `turn.plan.updated` snapshot

The `AskUserQuestion` payload shape is already close to the UI we want:

- `questions[]` array
- each question has `header` and `question`
- each question has `options[]` with `label` + `description`
- `multiSelect` is explicit

The main remaining unknown is the exact runtime shape of the **answer** payload that Claude expects back for this tool.


- `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'`

Confirmed from installed SDK typings:

- `/Users/julius/.bun/install/cache/@anthropic-ai/claude-agent-sdk@0.2.62@@@1/sdk.d.ts`
- `/Users/julius/.bun/install/cache/@anthropic-ai/claude-agent-sdk@0.2.62@@@1/sdk-tools.d.ts`

Claude also exposes plan-related tools/types:

- `ExitPlanMode`
- `AskUserQuestion`

These are strong signals that Claude’s plan UX is built around tool usage within a `permissionMode: 'plan'` session rather than a dedicated standalone `turn.plan.updated` event.

### What the wire stream exposes

Claude adapter input today is built from SDK messages like:

- `system:init`
- `system:status`
- `stream_event`
- `assistant`
- `result`
- hook/task/tool summary events

The SDK stream exposes:

- message deltas
- tool-use starts/stops via content blocks
- permission-mode metadata
- final result and usage

What it does **not** appear to expose as a first-class event:

- no direct equivalent to Codex `turn/plan/updated`
- no direct equivalent to Codex `item/plan/delta`
- no dedicated top-level `user-input.requested` transport event in the SDK stream

Instead, plan-mode-related behavior appears to surface through tool uses:

- `AskUserQuestion` tool
- `ExitPlanMode` tool
- regular content/tool stream events

### Semantics

#### Plan mode

Claude’s plan mode is primarily a **permission / behavior mode**:

- session or turn is created with `permissionMode: 'plan'`
- tool execution is prevented / constrained
- assistant can explore, reason, and propose a plan
- eventually it may call `ExitPlanMode` to transition toward implementation

That means Claude plan mode is native, but **structured plan state is not guaranteed**.

In practice, there are two likely UI strategies:

1. **Best-effort structured extraction**
   - detect plan-like assistant/tool outputs
   - synthesize `turn.plan.updated` from them
2. **Text-first plan rendering**
   - show reasoning / assistant output as plan narrative
   - only emit `turn.plan.updated` when we can confidently extract steps

#### Asking user questions

Claude’s `AskUserQuestion` appears to be a tool, not a dedicated transport-level question request primitive.

That means the adapter likely needs to:

- identify `tool_use` for `AskUserQuestion`
- parse its input payload into canonical question schema
- expose `user-input.requested`
- accept a user answer and feed it back as the tool result / synthetic user response, depending SDK control path

This is adapter work, not just schema plumbing.

### Recommended stance for Claude

Claude should support the same canonical user-facing contract, but the adapter will need to **manufacture structure from native tool activity**.

Recommended mapping:

- `permissionMode: 'plan'` => canonical session/turn metadata `mode = plan`
- `AskUserQuestion` tool use => canonical `user-input.requested`
- submitted answer => canonical `user-input.resolved`
- `ExitPlanMode` tool use => canonical state transition or request to continue with implementation
- assistant text / tool summaries in plan mode => optional synthesized `turn.plan.updated`

### Risk / uncertainty

Claude currently appears less deterministic than Codex for structured plans.

Main unknowns to resolve during implementation:

- exact `AskUserQuestion` tool input/output payload shapes at runtime
- whether freeform responses are supported natively or need synthetic augmentation
- whether `ExitPlanMode` should be exposed to UI explicitly or handled internally by the adapter/session controller

---

## Provider 3: Cursor ACP

### What exists natively

Cursor ACP does have native session modes.

Confirmed by local probe output in `.tmp/acp-plan-probe/summary.json`:

- `agent`
- `plan`
- `ask`

The probe also confirmed current primary ACP update surfaces:

- `available_commands_update`
- `agent_thought_chunk`
- `agent_message_chunk`
- `tool_call`
- `tool_call_update`
- `session/request_permission`

### What the probe did not find

The existing probe did **not** surface:

- structured plan update events
- a dedicated “ask user question” request
- a dedicated plan delta stream

The current ACP surface therefore looks much thinner than Codex.

### Semantics

#### Plan mode

Cursor `plan` mode clearly exists as a session mode, but as currently observed it seems to mean:

- read-only / design-first behavior
- regular thought/message chunk streaming
- no dedicated structured plan payload

So the plan is native as a mode, but not obviously as a structured protocol surface.

#### Asking the user questions

Cursor ACP currently gives us a nearby primitive only for **permission requests**:

- `session/request_permission`

That is not the same as product-level question asking.

The existence of `ask` mode suggests Cursor may handle asking by:

- normal assistant prose in ask mode
- possibly mode-switch semantics
- possibly skills/commands that we have not yet triggered

But based on current probe evidence, we should **not assume** a Codex-style structured question API exists in ACP.

### Recommended stance for Cursor

Treat Cursor as:

- native support for `mode = plan`
- no proven native support for structured plan steps
- no proven native support for structured user-input questions

Therefore Cursor likely needs the most adapter synthesis:

- derive plan-mode state from ACP session mode
- optionally synthesize `turn.plan.updated` from assistant text if we can extract steps safely
- for interactive questions, likely fall back to regular conversational turns unless a richer ACP mechanism is discovered

### Important product implication

If we want the same rich “multiple-choice question card” UX across all providers, Cursor may need one of these paths:

1. **Provider-native path** if later ACP exploration finds structured user question primitives
2. **Adapter-mediated path** where the provider is instructed to emit a machine-readable question block in text and adapter parses it
3. **Capability downgrade** where Cursor only supports conversational follow-up, not full structured plan-question cards

Today, evidence supports option 3 as the safe baseline.

---

## Cross-provider comparison

### Capability matrix

| Capability | Codex App Server | Claude Agent SDK | Cursor ACP |
| --- | --- | --- | --- |
| Native plan mode | Yes | Yes | Yes |
| Structured plan update event | Yes | Not obvious / likely no | Not observed |
| Plan text delta stream | Yes | Not first-class | Not observed |
| Native structured user question API | Yes | Tool-based, likely yes-ish | Not observed |
| Native answer resolution lifecycle | Yes | Likely adapter-mediated | Not observed |
| Best provider for canonical contract | Strong | Medium | Weak |

### Core insight

“Plan mode” means **different things** across providers:

- **Codex**: plan mode is a first-class runtime concept with structured plan and question surfaces.
- **Claude**: plan mode is a first-class permission mode, but structured plan/question UI likely needs adapter interpretation.
- **Cursor**: plan mode is a first-class session mode, but richer plan/question structure is not currently exposed.

---

## Recommended provider-agnostic contract

We should separate three concerns that are currently easy to conflate.

### 1. Session / turn mode

A canonical mode flag:

- `default`
- `plan`
- `ask`
- `execute`
- `unknown`

This is about **agent operating mode**, not UI widgets.

### 2. Structured plan state

A canonical plan model:

```ts
interface CanonicalPlanState {
  explanation?: string | null;
  steps: Array<{
    id?: string;
    text: string;
    status: 'pending' | 'inProgress' | 'completed';
    source: 'native' | 'synthesized';
  }>;
}
```

Rules:

- Codex can populate this natively.
- Claude/Cursor may populate it only when extraction is confident.
- UI should tolerate absence of structured plan state.

### 3. Structured user-input prompt

Canonical prompt should be modeled independently of approvals:

```ts
interface CanonicalUserInputPrompt {
  promptId: string;
  title?: string;
  description?: string;
  questions: Array<{
    id: string;
    label: string;
    description?: string;
    options: Array<{
      id: string;
      label: string;
      description?: string;
      recommended?: boolean;
    }>;
    allowFreeform?: boolean;
    freeformPlaceholder?: string;
    required?: boolean;
  }>;
  source: 'native' | 'tool-derived' | 'synthesized';
}
```

And answers:

```ts
interface CanonicalUserInputAnswer {
  promptId: string;
  answers: Array<{
    questionId: string;
    selectedOptionId?: string;
    text?: string;
  }>;
}
```

### Why separate `request.opened` from `user-input.requested`

Because they are not the same abstraction:

- approvals = “may I run/edit/do X?”
- user-input prompts = “which direction do you want?”

Codex already blurs these at transport level because `item/tool/requestUserInput` is a request.
But product and UI should keep them separate.

Recommended rule:

- keep `request.opened/request.resolved` for transport-level correlation
- keep `user-input.requested/user-input.resolved` for product-level UX

---

## Adapter strategy by provider

### Codex adapter

Use native primitives directly.

Implementation target:

- preserve `turn.plan.updated`
- preserve `content.delta(plan_text)`
- preserve `user-input.requested`
- preserve `user-input.resolved`
- expose raw/native metadata for future UI improvements

### Claude adapter

Implement tool-aware adaptation.

Implementation target:

- treat `permissionMode: 'plan'` as native plan-mode state
- detect `AskUserQuestion` tool uses and convert to canonical user-input prompt
- convert question answers back into Claude-native tool response path
- detect `ExitPlanMode` and emit a canonical mode-change / handoff event
- optionally synthesize plan steps from assistant output in plan mode

### Cursor adapter

Implement conservative degraded support first.

Implementation target:

- expose native session mode including `plan` and `ask`
- do not claim structured plan updates unless proven
- do not claim structured user-input prompts unless proven
- optionally add a provider capability flag so UI can fall back to conversational follow-up

---

## Capability flags we should add

To avoid overpromising in the UI, add provider runtime capabilities such as:

```ts
interface ProviderInteractiveCapabilities {
  supportsPlanMode: boolean;
  supportsAskMode: boolean;
  supportsStructuredPlanUpdates: boolean;
  supportsPlanTextStreaming: boolean;
  supportsStructuredUserInput: boolean;
  supportsFreeformUserInput: boolean;
  supportsExitPlanMode: boolean;
}
```

Expected initial values:

- Codex: all or nearly all `true`
- Claude: `supportsPlanMode=true`, `supportsStructuredUserInput=likely true via adapter`, `supportsStructuredPlanUpdates=partial`
- Cursor: `supportsPlanMode=true`, `supportsAskMode=true`, most structured flags `false`

This lets the UI:

- render rich plan cards only when supported
- fall back to plain assistant text + reply box otherwise
- avoid coupling the design to Codex-specific assumptions

---

## Suggested implementation order

1. **Formalize provider capability flags**
   - make support explicit before UI work
2. **Finish canonical user-input contracts**
   - question schema, answer schema, source markers
3. **Codex end-to-end implementation first**
   - closest match to desired UX
4. **Claude adapter translation second**
   - parse `AskUserQuestion` and `ExitPlanMode`
5. **Cursor degraded plan-mode support third**
   - mode awareness first, richer structure later
6. **UI renders by capability, not provider name**
   - prevents provider-specific branching from leaking upward

---

## Open questions

1. Claude runtime payloads:
   - what exact `AskUserQuestion` input/output shapes arrive over the stream?
2. Claude answer submission path:
   - should answers be injected as tool results, control responses, or synthetic user turns?
3. Cursor ACP:
   - is there an undocumented or less common interactive prompt primitive beyond `session/request_permission`?
4. Cursor mode switching:
   - can ACP session mode change mid-session, and is that surfaced as `session/update` or request/response only?
5. Plan synthesis:
   - do we want best-effort extraction of numbered/bulleted plans into `turn.plan.updated` for Claude/Cursor, or should we keep structured plans native-only at first?

---

## Immediate recommendation

Build the product contract around **capabilities**, not around the assumption that every provider has Codex-style plan/question primitives.

Concretely:

- Codex should drive the first full UX implementation.
- Claude should be supported with adapter-derived question handling and partial/synthesized plan state.
- Cursor should initially support mode-aware UX with graceful fallback to conversational replies rather than full structured question cards.

That gives us a provider-agnostic architecture without pretending the underlying protocols are already equivalent.
