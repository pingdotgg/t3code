# Plan Mode Implementation Plan

## Goal

Implement plan mode in a provider-agnostic way across:

- Codex App Server
- Claude Agent SDK / Claude Code
- Cursor ACP

The implementation must support:

- provider-native or adapter-derived plan mode state
- structured user-input question flows where available
- graceful fallback when a provider lacks structured prompts or structured plan updates
- a front-end UX that renders from capabilities and canonical events rather than provider-specific conditionals

This document now serves as both:

- the architecture plan for shared orchestration and UI wiring
- the provider adapter implementation plan for each supported agent runtime

---

## Source of truth

### Codex

Codex protocol decisions should be based on the open-source app-server protocol, not on local rollout session files.

Upstream Codex app-server explicitly supports:

- `turn/plan/updated`
- `item/plan/delta`
- `item/tool/requestUserInput`
- `serverRequest/resolved`
- lower-level `EventMsg` variants `plan_update`, `plan_delta`, and `request_user_input`

Important implication:

- local Codex rollout JSONL files are a lossy or higher-level projection
- they may preserve plan mode state and final `<proposed_plan>` output
- they should not be treated as proof that low-level plan events do or do not exist

### Claude

Claude protocol decisions should be based on:

- installed SDK typings
- real local session JSONL evidence

Confirmed from local Claude transcript:

- `AskUserQuestion` is a native `tool_use`
- `ExitPlanMode` is a native `tool_use`
- `AskUserQuestion.input.questions[]` is structured and adapter-parseable

### Cursor

Cursor protocol decisions should be based on:

- ACP docs
- current local ACP probe output

Confirmed from current docs + probe:

- ACP session modes include `agent`, `plan`, and `ask`
- for product semantics, treat ACP mode as binary: `operatingMode: default | plan`
- Cursor ACP extension methods include:
  - `cursor/ask_question` (multiple-choice question prompt)
  - `cursor/create_plan` (explicit plan approval request)
  - `cursor/update_todos` (todo-state updates that can drive plan-step UI)
- probe streams still show standard chunk/update events and may not always emit extension methods in every run

---

## High-level product model

The implementation should separate three concepts that are currently easy to conflate.

### 1. Operating mode

This is the agent runtime mode.

Canonical operating mode:

- `default`
- `plan`

This should be represented at runtime independently of plan content or prompt cards.

### 2. Structured plan state

This is the current structured plan snapshot, if the provider can supply one natively or if the adapter can synthesize one confidently.

Canonical model:

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

### 3. Structured user-input prompt

This is the product-level question card model.

Canonical model:

```ts
interface CanonicalUserInputPrompt {
  promptId: string;
  title?: string;
  description?: string;
  questions: Array<{
    id: string;
    header?: string;
    label: string;
    description?: string;
    options: Array<{
      id: string;
      label: string;
      description?: string;
      recommended?: boolean;
    }>;
    multiSelect?: boolean;
    allowFreeform?: boolean;
    freeformPlaceholder?: string;
    required?: boolean;
  }>;
  source: 'native' | 'tool-derived' | 'synthesized';
}

interface CanonicalUserInputAnswer {
  promptId: string;
  answers: Array<{
    questionId: string;
    selectedOptionIds?: string[];
    text?: string;
  }>;
}
```

This should remain distinct from approvals.

---

## Shared orchestration plan

## Summary

Implement a canonical plan-mode interaction pipeline that starts in provider adapters, flows through provider runtime ingestion and orchestration projection, and terminates in capability-driven frontend rendering and response submission.

### Shared goals

- normalize plan mode state from each provider
- normalize structured prompts where possible
- preserve native payloads for later refinement
- avoid UI coupling to provider names
- support degraded conversational fallback where native structured prompts are unavailable

---

## Orchestration work items

### 1. Extend canonical provider runtime contracts

Files:

- `packages/contracts/src/providerRuntime.ts`
- `packages/contracts/src/provider.ts`
- `EVENTS.md`

Add or formalize the following runtime concepts:

- provider interactive capability payload
- plan-mode state event or mode metadata surface
- canonical structured user-input payload schema
- canonical structured user-input answer payload schema
- final-plan handoff payload for providers that emit a completed plan as text or tool output

Required additions:

```ts
interface ProviderInteractiveCapabilities {
  supportsPlanMode: boolean;
  supportsStructuredPlanUpdates: boolean;
  supportsPlanTextStreaming: boolean;
  supportsStructuredUserInput: boolean;
  supportsFreeformUserInput: boolean;
  supportsExitPlanMode: boolean;
}
```

Canonical runtime behavior:

- `request.opened/request.resolved` remain transport-oriented
- `user-input.requested/user-input.resolved` remain product-oriented
- `turn.plan.updated` remains the canonical structured plan update event
- `content.delta(streamKind=plan_text)` remains the canonical streaming plan text surface

### 2. Add canonical mode/capability publication from providers

Files:

- `apps/server/src/provider/Layers/*Adapter.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`

Each adapter should publish provider capabilities and current operating mode early in session startup and when mode changes.

Preferred shape:

- capabilities included in `session.configured`
- current mode included in `session.configured`, `session.state.changed`, or a dedicated mode field on turn/session runtime metadata

### 3. Preserve and project plan/user-input state in orchestration

Files:

- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- any orchestration projection models feeding the web socket domain events

Implementation requirements:

- persist latest structured plan snapshot per active turn
- persist pending structured user-input prompts per turn
- persist resolved answers for history rendering
- preserve raw/native payloads for debugging and future adapter improvements

### 4. Add frontend state model for plan mode

Files likely involved:

- web app session/thread stores
- conversation/event rendering layer
- input composer / pending interaction surfaces

Add frontend state for:

- current provider capabilities
- current operating mode
- pending structured prompt
- structured plan snapshot
- streaming plan text buffer
- final plan handoff state when present

### 5. Implement capability-driven UI rendering

UI rules:

- if `supportsStructuredUserInput`, render the multi-question card UI
- if not, fall back to standard conversational reply flow
- if `supportsStructuredPlanUpdates`, render status-tracked plan steps
- if only `supportsPlanTextStreaming`, render streaming plan prose
- if neither exists, render standard assistant content in plan mode with clear mode indicator

### 6. Implement front-to-back response submission path

Requirements:

- question card submit sends canonical answer payload to server
- server routes answer to the correct provider adapter pending request/tool context
- resolved provider response emits both:
  - `user-input.resolved`
  - `request.resolved` when applicable

### 7. History and reconnect behavior

Requirements:

- pending structured prompts should survive reconnect/resubscribe if still active
- resolved prompts should be rendered in history as completed interactions
- plan snapshots should be replayable from persisted orchestration activity
- current streaming plan text should resume cleanly on reconnect if provider continues emitting deltas

---

## Provider adapter plans

## Provider 1: Codex App Server

### Summary

Codex is the reference implementation and should be wired as the strongest native provider.

### Native protocol mapping

Source of truth: upstream open-source app-server protocol.

Native incoming surfaces:

- `turn/plan/updated`
- `item/plan/delta`
- `item/tool/requestUserInput`
- `serverRequest/resolved`
- lower-level `EventMsg.plan_update`
- lower-level `EventMsg.plan_delta`
- lower-level `EventMsg.request_user_input`

### Adapter implementation

Files:

- `apps/server/src/provider/Layers/CodexAdapter.ts`
- related tests in `apps/server/src/provider/Layers/*Codex*.test.ts`

Implementation requirements:

1. Keep native structured plan updates as-is:
- `turn/plan/updated` -> `turn.plan.updated`

2. Keep native plan text streaming as-is:
- `item/plan/delta` -> `content.delta` with `streamKind: "plan_text"`

3. Keep native structured user-input as-is:
- `item/tool/requestUserInput` -> `user-input.requested`
- also emit `request.opened` with a transport request type

4. On client answer submission:
- route answer to the corresponding Codex pending request id
- emit `user-input.resolved`
- observe/forward `serverRequest/resolved` -> `request.resolved`

5. Publish capabilities:
- `supportsPlanMode = true`
- `supportsStructuredPlanUpdates = true`
- `supportsPlanTextStreaming = true`
- `supportsStructuredUserInput = true`
- `supportsFreeformUserInput = true` if answer payload supports note/text in practice
- `supportsExitPlanMode = false` unless a separate explicit tool/event is introduced

### Codex-specific tests

- `turn/plan/updated` maps to canonical structured plan state
- `item/plan/delta` maps to `plan_text`
- `item/tool/requestUserInput` maps to canonical structured prompt shape
- answer response resolves pending request and emits both canonical resolved events
- reconnect/history replay preserves plan snapshot and pending prompt

---

## Provider 2: Claude Agent SDK / Claude Code

### Summary

Claude requires tool-aware adaptation. Native structured interaction exists, but it is surfaced through `tool_use` blocks rather than dedicated transport events equivalent to Codex.

### Real native evidence

From the local Claude session transcript:

- `AskUserQuestion` arrives as:
  - assistant message
  - content block type `tool_use`
  - `name: "AskUserQuestion"`
  - `input.questions[]`
- `ExitPlanMode` arrives as:
  - assistant message
  - content block type `tool_use`
  - `name: "ExitPlanMode"`
  - `input.plan` containing finalized plan text/spec

Claude also has native:

- `permissionMode: 'plan'`
- `system:init.permissionMode`
- `system:status.permissionMode`

### Adapter implementation

Files:

- `apps/server/src/provider/Layers/ClaudeCodeAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeCodeAdapter.test.ts`

Implementation requirements:

1. Publish native operating mode:
- `permissionMode: 'plan'` -> canonical mode `plan`
- all other values -> canonical mode `default`

2. Detect `AskUserQuestion` tool uses:
- inspect `tool_use` blocks in assistant messages / stream events
- when `name === 'AskUserQuestion'`, convert `input.questions[]` to canonical `user-input.requested`
- also emit `request.opened` using a Claude-specific tool-user-input request type

3. Canonical question mapping for Claude:
- `header` -> canonical `header`
- `question` -> canonical `label`
- `options[].label` -> canonical option label
- `options[].description` -> canonical option description
- `multiSelect` -> canonical `multiSelect`
- source = `tool-derived`

4. Implement answer submission path:
- on UI answer submit, convert canonical answers back into whatever Claude expects for the `AskUserQuestion` tool result path
- emit `user-input.resolved`
- emit `request.resolved`

5. Detect `ExitPlanMode` tool uses:
- when `name === 'ExitPlanMode'`, parse `input.plan`
- emit a final plan handoff event and/or synthesize a `turn.plan.updated` snapshot if safe
- treat this as the boundary between planning and implementation readiness

6. Structured plan behavior:
- Claude does not currently appear to expose a native `turn/plan/updated` equivalent
- initial implementation should not over-synthesize incremental steps
- use two-tier strategy:
  - tier 1: preserve plan-related assistant text in `plan_text` only if clearly attributable
  - tier 2: optionally synthesize `turn.plan.updated` from explicit structured plan strings only when parsing is robust

7. Publish capabilities:
- `supportsPlanMode = true`
- `supportsStructuredPlanUpdates = partial/false initially`
- `supportsPlanTextStreaming = partial`
- `supportsStructuredUserInput = true`
- `supportsFreeformUserInput = unknown/false until answer path confirmed`
- `supportsExitPlanMode = true`

### Claude-specific tests

- `system:init` and `system:status` publish plan mode metadata
- `AskUserQuestion` tool maps into canonical prompt schema
- multi-select and option descriptions round-trip correctly
- answer submission resolves the pending prompt
- `ExitPlanMode` tool emits final plan handoff state
- ordinary tool uses do not get misclassified as prompts or plan exits

### Claude-specific open question to resolve during implementation

- exact runtime shape expected for the answer payload returned to `AskUserQuestion`

Implementation default:

- build adapter abstraction so only the final answer-serialization function is provider-specific and easily swappable once runtime shape is confirmed

---

## Provider 3: Cursor ACP

### Summary

Cursor should ship with binary plan-mode semantics (`default | plan`) and implement documented ACP extension methods when present. If extension methods are absent in a given session, it should degrade cleanly to mode + streamed assistant text.

### Real native evidence

From the Cursor ACP docs + current probe:

- available modes include `agent`, `plan`, and `ask`
- Cursor ACP docs define extension methods:
  - `cursor/ask_question`
  - `cursor/create_plan`
  - `cursor/update_todos`
- observed updates include:
  - `available_commands_update`
  - `agent_thought_chunk`
  - `agent_message_chunk`
  - `tool_call`
  - `tool_call_update`
- observed request type:
  - `session/request_permission`

Current caveats:

- no standard ACP event equivalent to Codex `turn/plan/updated`
- no standard ACP event equivalent to Codex `item/plan/delta`
- extension-method payload shapes should be fixture-captured from live sessions before locking parser assumptions

### Adapter implementation

Files:

- `apps/server/src/provider/Layers/CursorAdapter.ts`
- `apps/server/src/provider/Layers/CursorAdapter.test.ts`
- probe scripts under `scripts/`

Implementation requirements:

1. Publish native operating mode:
- map ACP `plan` mode -> canonical `plan`
- map ACP `agent` and `ask` modes -> canonical `default`
- preserve raw ACP mode in native metadata for debugging

2. Implement documented Cursor extension methods:
- `cursor/ask_question` -> canonical `user-input.requested`
- `cursor/update_todos` -> canonical `turn.plan.updated` when payload is parseable into stable step ids/text/status
- `cursor/create_plan` -> canonical final-plan handoff / approval-request surface

3. Use graceful fallback behavior:
- render plan mode as mode state + assistant text stream
- if no `cursor/ask_question` event is emitted, fall back to normal conversational input
- if no parseable `cursor/update_todos` event is emitted, fall back to text-only plan rendering

4. Preserve room for future enrichment:
- keep raw ACP notifications available in native event logs
- extend the ACP probe to search for hidden or uncommon prompt/mode-change surfaces

5. Publish capabilities:
- `supportsPlanMode = true`
- `supportsStructuredPlanUpdates = true` when `cursor/update_todos` is available, otherwise false
- `supportsPlanTextStreaming = false` initially (no distinct plan-text channel)
- `supportsStructuredUserInput = true` when `cursor/ask_question` is available, otherwise false
- `supportsFreeformUserInput = false` via structured prompt path
- `supportsExitPlanMode = false`

### Cursor-specific tests

- ACP mode metadata maps to `plan` vs `default` correctly
- `cursor/ask_question` maps into canonical structured prompt schema
- `cursor/update_todos` maps into canonical structured plan state when parseable
- `cursor/create_plan` maps into final-plan handoff / approval surface
- `agent_thought_chunk` and `agent_message_chunk` still render normally in plan mode
- fallback conversational flow remains functional

### Cursor-specific follow-up probe work

Add dedicated probes for:

- mode-switching during an active session
- real payload shapes for `cursor/ask_question`, `cursor/create_plan`, and `cursor/update_todos`
- any request types besides `session/request_permission`
- whether extension methods are always emitted or only for specific prompt styles

---

## Frontend implementation plan

### Summary

Render plan mode through a single UI model driven by canonical events and provider capabilities.

### UI states to support

- standard conversation
- plan mode with structured steps
- plan mode with text-only plan stream
- pending structured question card
- resolved question card in history
- final plan handoff / completed plan artifact

### Rendering rules

1. Show operating mode indicator whenever current mode is `plan`
2. Show structured question card only when a pending `user-input.requested` exists
3. Show structured plan step list when a current `turn.plan.updated` snapshot exists
4. Append `plan_text` streaming content beneath or alongside structured steps when both exist
5. Fall back to assistant text rendering when provider capabilities do not support structure
6. Show completed selected answers in history after `user-input.resolved`

### Submission behavior

- option click / freeform answer submits canonical answer payload
- disable duplicate submits while request is pending resolution
- preserve pending-card state across reconnects if request remains open

---

## Data flow end to end

1. Provider starts session and publishes capabilities + mode
2. User starts plan-mode turn or provider enters plan mode
3. Adapter emits structured plan and/or plan text events when available
4. Adapter emits `user-input.requested` when provider asks a structured question
5. Frontend renders question card or fallback conversational prompt based on capabilities
6. User submits answer
7. Server routes answer back to provider adapter pending request/tool context
8. Adapter emits `user-input.resolved` and `request.resolved`
9. Provider may continue planning, emit more plan updates, or emit final plan handoff
10. Frontend renders final completed plan state and history

---

## Test plan

### Contracts

Files:

- `packages/contracts/src/providerRuntime.test.ts`
- related schema tests

Add coverage for:

- provider capabilities schema
- structured user-input prompt schema
- structured user-input answer schema
- mode metadata schema

### Server/provider tests

Files:

- `apps/server/src/provider/Layers/CodexAdapter.test.ts`
- `apps/server/src/provider/Layers/ClaudeCodeAdapter.test.ts`
- `apps/server/src/provider/Layers/CursorAdapter.test.ts`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`

Add coverage for:

- capabilities emission
- mode propagation
- plan update propagation
- plan text propagation
- structured prompt lifecycle
- answer resolution lifecycle
- reconnect/history replay behavior

### Web/UI tests

Add coverage for:

- question card rendering from canonical prompt
- question answer submission
- resolved question history rendering
- structured plan step rendering
- text-only plan rendering
- capability-based fallback rendering for Cursor

### Probe / fixture tests

- preserve the Claude transcript-derived `AskUserQuestion` and `ExitPlanMode` payloads as fixtures
- preserve Codex protocol fixtures for `turn/plan/updated`, `item/plan/delta`, and `item/tool/requestUserInput`
- preserve ACP probe summaries as fixtures for unsupported-capability assertions

---

## Assumptions and defaults

- Codex is the reference provider for full structured plan/question UX.
- Claude supports structured prompts via tool adaptation, but incremental structured plan updates are not assumed initially.
- Cursor transport exposes `agent|plan|ask`, but product semantics collapse this to `operatingMode: default | plan`.
- Cursor structured prompts/plan steps are driven by ACP extension methods when present, with fallback when absent.
- Product/UI should degrade gracefully rather than invent unsupported provider behavior.
- Raw provider payloads should always be retained where feasible to support future adapter refinement.

---

## Recommended execution order

1. Formalize canonical capabilities + mode + structured prompt contracts
2. Wire capabilities/mode through orchestration and web socket projections
3. Finish Codex end-to-end plan mode implementation first
4. Implement Claude `AskUserQuestion` and `ExitPlanMode` adapter mapping
5. Add Cursor binary (`default|plan`) mode support + ACP extension-method mapping
6. Build capability-driven frontend rendering and answer submission
7. Add reconnect/history coverage and transcript/protocol fixtures
