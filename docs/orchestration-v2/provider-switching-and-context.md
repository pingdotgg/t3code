# Provider Switching And Context Handoff

Provider switching is a first-class V2 feature. An app thread may contain runs from multiple providers while preserving each provider's native conversation handles and the app's canonical conversation history.

This document describes the provider-switching specialization of the broader [Thread Lineage And Context Transfer](./thread-lineage-and-context-transfer.md) model. Provider switching is a context transfer where the source and target app thread are usually the same thread. Forking, merge-back, and subagents use the same source-point/resolution concepts with different product lifecycles.

## Recommendation

When returning to a provider that was used earlier, default to resuming that provider's previous provider thread and inject a delta summary covering the runs that happened while the provider was inactive.

Create a fresh provider thread with a full app-thread summary only when resuming the prior provider thread fails, settings are incompatible, or delta handoff is likely to produce poor context.

This gives the best default tradeoff:

- preserves native continuity for provider-specific prior work,
- avoids repeatedly summarizing everything,
- lets each provider keep its own tool/history affordances,
- makes cross-provider context explicit and auditable,
- keeps a clean fallback when old provider context is stale.

## Example

```text
runs 1-5: Codex, ProviderThread C1
switch to Claude for run 6
  -> ContextHandoff H1 covers runs 1-5
  -> create ProviderThread L1
  -> run 6 uses L1 with H1
runs 6-8: Claude, ProviderThread L1
switch back to Codex for run 9
  -> ContextHandoff H2 covers runs 6-8
  -> resume ProviderThread C1
  -> run 9 uses C1 with H2
```

ProviderThread C1 is not expected to natively contain Claude's runs. It contains Codex's native conversation plus explicit handoff artifacts that summarize external progress.

## Why Not Always Create A Fresh Provider Thread?

Always creating a fresh provider thread is simpler but loses useful provider-native continuity:

- prior hidden reasoning/context that is only available in the provider thread,
- provider-side thread metadata,
- native tool state where available,
- continuity for provider-specific behavior.

It also forces every switch to depend on full summarization quality. Full summaries are useful fallback artifacts, but they should not be the default when a previous provider thread can be safely resumed.

## Why Not Resume Without Summary?

Because the app thread moved on while the provider was inactive. The resumed provider would not know what another provider did. That creates wrong answers, stale plans, and unsafe file assumptions.

Returning to a provider requires a handoff summary unless no runs happened since that provider last participated.

## Provider Thread Coverage

Provider threads have native coverage and handoff coverage.

```ts
type ProviderThreadCoverage = {
  providerThreadId: ProviderThreadId;
  nativeRunOrdinals: number[];
  handoffIds: ContextHandoffId[];
};
```

For the example above:

```text
C1 native runs: 1,2,3,4,5,9
C1 handoffs: H2 covering 6-8

L1 native runs: 6,7,8
L1 handoffs: H1 covering 1-5
```

The app thread remains the source of truth for full history.

## Handoff Artifact

A handoff is explicit graph data. In the broader model, `ContextTransfer` records source, target, relationship type, and resolution status. `ContextHandoff` is the materialized portable context artifact used when the transfer cannot be satisfied by native provider continuity.

```ts
type ContextHandoff = {
  id: ContextHandoffId;
  transferId: ContextTransferId;
  threadId: ThreadId;
  targetRunId: RunId;
  fromProviderThreadIds: ProviderThreadId[];
  toProviderThreadId: ProviderThreadId;
  coveredRunOrdinals: { from: number; to: number };
  strategy:
    | "delta_since_target_last_seen"
    | "full_thread_summary"
    | "checkpoint_summary"
    | "manual_context";
  summaryText: string;
  status: "pending" | "ready" | "failed" | "superseded";
  createdByProvider: ProviderKind | null;
  createdAt: string;
  updatedAt: string;
};
```

The handoff should be linked to the run that consumes it. If the same summary is regenerated, the old handoff is superseded rather than mutated invisibly.

## Switch Flow

```text
start run with target provider P
  -> find current app thread history
  -> find best ProviderThread for P
  -> decide handoff strategy
  -> generate ContextHandoff if needed
  -> ensure ProviderSession for P
  -> ensure/resume/create target ProviderThread
  -> send provider turn with handoff context + user message
```

The user message remains the actual run input. The handoff context is a separate preamble/system/developer/synthetic-user context depending on provider capability.

## Strategy Selection

Recommended strategy order:

1. No handoff: target provider thread already has current app run coverage.
2. Delta handoff into existing provider thread: target provider thread can resume and only missed a run range.
3. Full thread handoff into existing provider thread: target provider can resume, but delta chain is too complex.
4. Full thread handoff into new provider thread: target provider resume failed, settings are incompatible, or old context is stale.
5. Unsupported: provider cannot accept handoff context and no safe reconstruction path exists.

## Staleness Policy

The app should be able to decide that returning to an old provider thread is no longer appropriate.

Possible staleness signals:

- too many off-provider runs since last use,
- too many chained handoffs,
- target provider model/runtime mode changed incompatibly,
- provider thread resume failed,
- prior provider thread was rolled back or forked in a conflicting way,
- user selected "clean context",
- handoff summary would exceed provider context policy.

When stale, create a new provider thread with `full_thread_summary`.

## Summarization Source

Summaries can be generated by:

- the provider being left,
- the provider being entered,
- a configured summarization provider,
- a local deterministic summarizer for structured artifacts.

The summary generator is not necessarily the target provider. The handoff records `createdByProvider` so quality and provenance can be inspected later.

## What The Summary Should Contain

The summary should be app-thread canonical, not provider transcript-only.

Include:

- user goals and constraints,
- decisions made,
- files changed,
- commands/tests run,
- plans/todo state,
- unresolved approvals/questions,
- current checkpoint/diff summary,
- known failures,
- relevant subagent results.

Do not include:

- irrelevant provider protocol noise,
- hidden chain-of-thought,
- stale tool output that is superseded by later runs,
- large diffs when a file summary is enough.

## Checkpoint Interaction

Provider switching does not change checkpoint ownership. Checkpoints still attach to app runs.

However, handoff generation should reference the latest checkpoint and diff summary so the next provider has a correct workspace-state picture.

```text
run N completed
  -> checkpoint N captured
switch provider for run N+1
  -> handoff includes summary through checkpoint N
```

## Rollback Interaction

Rollback invalidates handoffs that cover rolled-back runs.

```text
rollback to run 5
  -> runs 6+ marked rolled_back
  -> handoffs covering 6+ marked superseded
  -> provider threads whose native/handoff coverage includes 6+ marked divergent or rolled back by capability
```

If the active provider supports provider rollback, call it. Otherwise, create a new provider thread from the retained app-thread summary when work resumes.

## Forking Interaction

Forking from a mixed-provider app thread should record app-thread lineage and a source point without requiring provider selection at fork time. Provider context is resolved lazily when the first run starts on the fork.

Examples:

- Fork from run 5 on Codex, first fork run uses Codex: prefer Codex native fork if the source refs are strong.
- Fork from run 5 on Codex, first fork run uses Claude: build portable context lazily at first dispatch.
- Fork from app checkpoint with no provider-native thread: create target provider thread with checkpoint/full-thread context.
- Fork from subagent provider thread: use the subagent's provider thread directly if stable, otherwise fall back to portable context.

## Data Model Changes

Provider switching requires:

- `Run.provider`
- `Run.providerThreadId`
- `Run.contextHandoffId`
- `ContextTransfer`
- `ProviderThread.firstRunOrdinal`
- `ProviderThread.lastRunOrdinal`
- `ProviderThread.handoffIds`
- `ContextHandoff`
- provider capabilities for handoff support

The app does not need separate conversation threads for provider switches. It needs multiple provider threads attached to the same app thread.
