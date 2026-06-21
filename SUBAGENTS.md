# UI-Aware Subagent Orchestration Plan

## Status

This plan has been updated after the implementation and review-fix pass. The feature is implemented for Codex only. Unsupported providers should continue using the previous inline subagent-output behavior until they expose durable child-thread lineage.

The current behavior is:

- A Codex subagent is represented as its own conversation thread.
- Active subagent threads appear in the sidebar nested under the direct parent that spawned them.
- Completed, errored, interrupted, or stopped subagent threads are normally hidden from the sidebar but remain reachable from the parent conversation view. When a terminal subagent conversation is the active route, that subagent and any intermediate subagent ancestors are shown in the sidebar at their normal nested positions until the user navigates away.
- In the VS Code extension sidebar, project chrome is hidden and conversation rows are shown directly. The same active/terminal subagent visibility rules apply, but the project-style indentation rail, extra child padding, and child-dot marker are suppressed so rows do not look visually nested under an omitted project row.
- A parent conversation view shows only parent-owned output and subagent summary blocks for direct children.
- Subagent summary blocks are normal tool activity entries. They remain visible while their referenced child is running, can be folded with surrounding tool activity such as `Worked for ...`, and update to the child thread's current running, completed, errored, interrupted, or stopped status.
- When Codex resumes an existing subagent with a follow-up prompt, the parent conversation appends a new subagent summary block for that resumed activity while preserving the original block, and the same child thread appears in the sidebar as running again until the resumed turn reaches a terminal state.
- A child conversation view shows the raw initial prompt that launched that child when Codex exposes it, followed by that child's output, tool calls, diffs, MCP calls, and other actions. Grandchildren appear only as blocks inside their direct parent child view.
- Users cannot prompt or steer a subagent. The child view exposes stop control only while the child is running and a header button for returning to its direct parent conversation.
- Stopping a parent does not automatically stop running children. Stopping a child explicitly targets that child.
- Archive/delete actions are exposed only for root parent conversations. The server orchestration decider owns descendant lifecycle cascade, so archiving or deleting a root parent includes active subagent descendants even if a particular client has not materialized every hidden child thread.

## Assessment

The original architecture had three important gaps: no durable parent/child thread lineage, no routeable hidden child-thread detail after completion, and parent timelines that mixed child output/actions into the parent view. Those gaps have now been addressed for Codex by carrying Codex child-session identity into orchestration metadata, projecting child threads as first-class threads, and rendering child work only in the child's own conversation.

The most important implementation choice is that a subagent is not just a special visual box. It is a real projected thread with a `parentRelation.kind === "subagent"` relation. The parent timeline keeps only a compact child reference block derived from the Codex collab lifecycle item, while child output and actions are ingested into the child thread's timeline.

## Implemented Data Model

Thread parentage is persisted on projected threads. The implemented shape is:

```ts
type OrchestrationThreadParentRelation =
  | {
      kind: "root";
      rootThreadId: ThreadId;
    }
  | {
      kind: "subagent";
      rootThreadId: ThreadId;
      parentThreadId: ThreadId;
      parentTurnId: TurnId | null;
      parentItemId: ProviderItemId;
      parentActivitySequence: number;
      providerThreadId: string;
      titleSeed: string | null;
      depth: number;
      startedAt: string;
      completedAt: string | null;
      status: "running" | "completed" | "errored" | "interrupted" | "stopped";
    };
```

The persistence migration stores this relation as explicit projection-thread columns, including root thread, direct parent thread, provider child thread id, parent activity sequence, title seed, depth, started/completed timestamps, and subagent status. Indexes support parent lookup and root lifecycle lookup.

Review fixes added preservation guards so a normal root/default projection upsert cannot overwrite an existing subagent relation for the same thread.

## Server Implementation

1. Codex child identity is mapped into deterministic local child thread ids from `parentThreadId + providerThreadId`. This intentionally avoids using `parentItemId`, because Codex may emit multiple collab lifecycle/control items for the same child provider thread.

2. Codex collab lifecycle items now carry `subagentChildren` metadata on the parent activity payload. Each child reference includes the provider thread id, local child thread id, optional parent item id, and optional title seed. Prompt-bearing `spawnAgent`, `resumeAgent`, and `sendInput` items start a new parent activity reference for the same child thread, while control-only `wait` and `closeAgent` items stay tied to the existing reference so they do not create duplicate blocks. The parent UI uses this metadata to render the compact `Subagent - <title>` block.

3. Codex collab lifecycle tracking preserves both the raw child prompt and the title seed. The raw prompt comes from the collab tool item `prompt` field and is used as displayable child-thread conversation history; the title seed remains the input for generated child titles and parent summary labeling. Whitespace-only raw prompts are ignored.

4. Child-thread creation and updates happen through orchestration ingestion. The server preserves the direct parent, root thread id, depth, parent activity sequence, title seed, provider thread id, and started timestamp. When a terminal child is resumed from a new prompt-bearing parent activity, ingestion updates the existing child relation back to `running`, clears `completedAt`, records the new parent item id, and appends the follow-up prompt to the child conversation. Synthetic child shells are created so hidden child routes can be opened before the full projection catches up, and child runtime events that arrive with parent-collab metadata can synthesize the missing child shell before their output or tool activity is ingested.

5. When Codex exposes a raw child prompt, ingestion appends it to the child thread as a non-streaming user message through an internal `thread.message.user.append` command. The prompt message uses stable ids derived from `childThreadId + parentItemId`, is not bound to the parent turn, and is appended even if the child shell already exists because Codex first emitted a started item without a prompt and later emitted a completed item with the concrete prompt.

6. Child terminal status is derived from child lifecycle events, not from the parent collab item alone. Terminal updates apply only while the relation is still `running`, which prevents later `session.exited` events from overwriting a more specific `completed`, `errored`, `interrupted`, or `stopped` result.

7. Child stop/interrupt handling routes through the provider-bound root session while targeting the selected child thread/turn. Parent stop remains scoped to the requested parent thread and does not cascade to active children. If a child stop request cannot identify an active child turn, the server records an interrupt failure on the child, marks the child stopped, and does not fall back to the root session active turn.

8. Completed child detail remains tied to the root parent lifecycle. Root archive/delete requests are dispatched for the root thread, and the orchestration decider cascades active subagent descendants before the parent event. Force-deleting a project delegates through lifecycle roots so descendant subagents are not double-deleted. Delete still attempts to stop and close terminal state for involved lifecycle thread ids.

9. Unsupported providers keep the previous fallback behavior. No durable nested-thread behavior should be inferred for Claude, Cursor, OpenCode, or other providers until their event streams expose enough lineage to make child routing reliable.

## Web Implementation

1. Sidebar nesting is driven by `parentRelation`. Active subagents render under their direct parent only, and each visible generation uses its relation depth to add another indentation step. Terminal subagents are omitted from the sidebar during normal parent browsing, but the currently open terminal child path remains visible and indented while that child or nested descendant is selected. VS Code keeps this visibility/routing behavior while flattening row chrome because the extension sidebar omits the project row that normally provides the visual parent context.

2. Conversation detail routing accepts hidden child threads through projected/synthetic shells. A child thread can be opened from its parent block even after it has disappeared from the active sidebar.

3. Parent timelines render direct child summary blocks from `subagentChildren`. The block text is `Subagent` while the generated child title is pending or still the placeholder, then `Subagent - <title>` once a generated child title is available. The child title is generated from the child title seed derived from the initial subagent prompt when available, and raw child prompts are not used as the visible title fallback. Duration and status display use shared helpers, with running children described as `Working for <duration>` and completed children described as `Completed in <duration>`.

4. Child-bearing subagent rows are normal foldable tool activity entries, not special timeline overlays. They can be the visible latest row in a collapsed tool group or can fold behind the same `Worked for ...` summaries as any other tool entry, but they are not filtered out as neutral or empty while a child is still running.

5. Parent timelines do not render child prompt messages, child output, child shell commands, child file diffs, child MCP calls, or child action boxes. Those entries appear only inside the child thread view.

6. Child timelines render their raw launch prompt when available, then their own output/actions, and can render their own direct child summary blocks. This gives arbitrary-depth nesting without showing grandchildren in the original root parent view.

7. Child conversation views replace the normal composer with a subagent control bar. Users cannot send prompts to a subagent. While a child is running, the available user control is stop; the client includes the child's latest turn id when available so the server does not have to infer from the root session's active turn. The chat header also includes an up-navigation button that opens the direct parent conversation.

8. Review fixes removed duplicate compact subagent rows from Codex control sequences such as `wait` and `closeAgent`. Parent timelines now de-dupe child reference rows by child thread id plus parent collab item id, so control repeats collapse while each prompt-bearing resumed child activity with a new parent item id renders as a new appended block, even when multiple activities happen in the same parent turn. When Codex emits multiple rows for the same child activity, the latest representative row owns the visible child reference while preserving the earlier title seed, so a later running `wait` row is not dropped behind an earlier spawn row.

9. Shared subagent display helpers keep duration and fallback labels consistent across parent blocks and child controls. Terminal child rows with missing completion timestamps show an explicit unknown-duration fallback instead of implying successful completion, and active children use `working` wording instead of `running` wording.

10. Shared workspace scoping helpers in `packages/client-runtime/src/environment/workspaceScope.ts` centralize visible project/thread selection for client surfaces that need to reason about active root threads, descendants, hidden subagent routes, and workspace-bound source-control context after the upstream connection-runtime rewrite.

11. Thread list and detail state share the client-runtime idle retention TTL, so short route/sidebar unmount gaps should not immediately drop hidden child-thread detail or active subagent sidebar state.

## Decisions Captured

- Persistence retention: child detail is tied to parent lifecycle.
- Provider scope: Codex only for first implementation; unsupported providers degrade to current behavior.
- Title semantics: use the child title seed from the Codex collab item, normally derived from the subagent's initial prompt.
- Prompt history semantics: use the raw Codex collab item prompt as the child thread's initial user message when available. Do not use the title seed as a fallback prompt, because generated/summarized title seeds are not necessarily the literal child instruction.
- Error semantics: child failures do not bubble up as parent failures. Parent status and child status are independent.
- Missing completion events: follow the same lifecycle behavior as normal agent sessions. Use available terminal events where present; otherwise preserve running/unknown state until a stop, interrupt, session exit, reconnect reconciliation, or later terminal event updates it.
- Stop behavior: stopping a parent does not stop children; stopping a child is allowed from the child view.
- Steering behavior: users cannot manually prompt or steer subagents.
- Diff/checkpoint semantics: child file changes affect the shared workspace and should be parent-visible in aggregate at the workspace level, while per-action rendering remains scoped to the child conversation view.
- Archive/delete semantics: root parent actions own descendant child lifecycle. Child and nested-child rows do not expose independent archive/delete actions.

## Verification Completed

The implementation and review fixes have been covered by focused automated tests and Playwright regression checks:

- Server tests cover Codex subagent ingestion, parent-collab child shell synthesis, child terminal status, parent-relation persistence, projection upsert preservation, child stop/interrupt routing through the provider-bound root session without root-turn fallback, root thread archive/delete lifecycle cascade through subagent descendants, and project force-delete behavior that deletes descendants only once.
- Server tests cover raw subagent prompt projection into child threads, including start-then-complete late prompt updates and whitespace-only prompt suppression.
- Web tests cover sidebar/thread state behavior, active terminal subagent ancestor visibility, per-generation sidebar indentation, duplicate parent subagent control-row removal, same-turn resumed child activity rows, visible running subagent rows inside collapsed tool groups, child composer suppression, subagent stop control behavior, and duration fallback labels.
- Client-runtime tests cover shared idle retention for stream-backed thread state across short subscriber gaps.
- Playwright checked Codex subagent behavior with marker prompts: before the prompt projection fix, the child view showed the output marker but not the initial prompt marker; after the fix, the child view showed the initial prompt marker followed by the output marker. Earlier Playwright coverage also checked that the parent showed exactly one compact subagent block, child output/actions did not leak into the parent, the child view was reachable from the parent block, the child view showed the child command/output, and the child view did not expose a prompt composer. Later nested Playwright coverage checked a parent-child-grandchild chain while still running: the parent conversation kept the child subagent activity row visible, the child conversation kept the grandchild subagent activity row visible, and the sidebar projected the three levels at depths 0, 1, and 2.

Current completion gates for this repo remain:

```sh
pnpm exec vp check
pnpm exec vp run typecheck
```

Use focused package tests for the changed surface. If native mobile code changes in a future pass, also run:

```sh
pnpm exec vp run lint:mobile
```

## Remaining Risks And Hardening Items

1. Diff/checkpoint aggregation is intentionally parent-visible at the workspace level, but the exact UI for aggregate root diffs should be audited separately. Per-action diff rendering is scoped to the child timeline.

2. Reconnect and restart behavior should be stress-tested with active children, especially when the parent reconnects after receiving child output but before receiving the parent collab lifecycle item.

3. Multi-client behavior needs broader coverage across web, desktop, VS Code, and mobile shells. The data model is shared, but route guards, sidebar shell subscriptions, and hidden-thread availability should be checked in each client surface.

4. Deep nesting should be load-tested with large active-child sets. The model supports arbitrary depth and the current UI indents each visible generation, but active-row sorting stability and large sibling groups still deserve stress coverage.

5. Unsupported provider fallback should remain explicit. If another provider later exposes durable child-thread lineage, it should be added provider-by-provider rather than by guessing from output text.
