# Epic 25 — Workflow Engine: Live-Launch Smoke Checklist

This is the **manual acceptance gate** for "the workflow engine is live-proven against a real
provider." It complements, but does not replace, the automated proof:

- `apps/server/src/t3work-workflowEngineReactor.integration.test.ts` drives the **real**
  production reactor (`T3workWorkflowEngineReactorLive`) through the **real** OrchestrationEngine
  - projection pipeline, with a _stub_ provider that emits real-shaped domain events. It proves
    the suspend→resume loop end to end with nobody manually resolving.
- This checklist proves the one thing a stub provider cannot: that a **real configured provider**
  emits the turn lifecycle in the shapes the reactor expects, and that the loop runs against it.

Only a human with a real provider configured can sign this off.

## What the loop is

The example recipe ([`apps/server/__fixtures__/t3work-exampleReview.workflow.ts`](../../apps/server/__fixtures__/t3work-exampleReview.workflow.ts))
does two interactive things through the durable engine:

1. `agent(prompt, { schema })` — spawns an isolated thread, starts an agent turn, and awaits the
   assistant's final message (validated against a schema). The run **suspends** here.
2. `thread.askUser(question, { schema })` — posts a question into the launching thread and awaits
   the user's reply. The run **suspends** here too.

Each suspension parks the run in `workflow_runs` (status `suspended`) plus a pending-ask record.
The production reactor (`apps/server/src/t3work-workflowEngineReactor.ts`) watches
`orchestration.streamDomainEvents` and resumes the parked run when the matching domain event lands:

- a **final assistant message** (`thread.message-sent`, `role: "assistant"`, `streaming: false`)
  resolves the `thread.turn` ask — with the assistant text **assembled from the streaming
  deltas** (the final marker event itself carries empty text; see Part 1 of the phase notes);
- a **user message** (`thread.message-sent`, `role: "user"`, `streaming: false`) resolves the
  `user.input` ask with the user's text.

## Preconditions

- [ ] A dev server is running with t3work enabled (`bun run dev:server` / `node --watch src/t3work-bin.ts`),
      backed by the SQLite persistence (not the in-memory/mock backend).
- [ ] At least one **real provider instance** is configured and healthy (e.g. `codex` or
      `claudeAgent`) — verify you can run an ordinary chat turn in a thread first.
- [ ] You know how to open a SQL shell against the server's SQLite DB (the same file the server
      booted with) to inspect `workflow_runs` and `workflow_journal`.
- [ ] The example recipe is discoverable from the project, or you can POST to the launch route
      directly (see "Launching" below).
- [ ] Server logs are visible (stdout or the configured log sink).

## Launching

Launch from the UI/composer if the example recipe surfaces as a launchable action. Otherwise hit
the route directly (the engine does not yet support headless launches — a launching thread is
required):

```
POST /api/t3work/thread/recipe-workflow/launch
{
  "threadId": "<an existing thread id in the target project>",
  "launch": {
    "workflowPath": "<absolute path to t3work-exampleReview.workflow.ts>",
    "parameters": { "prTitle": "Fix the billing rounding bug" }
  }
}
```

Record the `runId` returned (also the `run_id` in `workflow_runs`).

## Step-by-step checks

### 1. Launch → agent turn dispatched → suspends on the agent turn

- [ ] **UI/stream:** a new isolated thread is created and an agent turn begins streaming into it.
      (The launching thread itself shows no agent turn yet — `agent()` runs in a spawned thread.)
- [ ] **DB:** a `workflow_runs` row exists for the `runId`:
      `sql
SELECT run_id, status, pending_thread_id, pending_kind, pending_correlation_id
FROM workflow_runs WHERE run_id = '<runId>';
`
      Expect `status = 'suspended'`, `pending_kind = 'thread.turn'`, and `pending_thread_id`
      equal to the **spawned** thread's id (it looks like `<runId>:1`, **not** the launch thread).
- [ ] **DB:** `workflow_journal` has the fired verbs:
      `sql
SELECT seq, phase, kind FROM workflow_journal WHERE run_id = '<runId>' ORDER BY seq;
`
      Expect `sent` entries for `thread.create` and `thread.turn`, with **no** `resolved` entry yet.
- [ ] **Logs:** the orchestration engine dispatched `thread.create` then `thread.turn.start` for
      the spawned thread; the provider command reactor started a real provider turn.

### 2. Agent turn completes → reactor resumes → run advances to `askUser`

- [ ] **UI/stream:** the agent turn finishes in the spawned thread (final assistant message rendered).
- [ ] **Logs:** **no** warning from `t3work workflow-engine reactor failed to process event`.
      (Any such warning is a real bug — capture the cause.)
- [ ] **DB:** the run flipped its pending ask to the user escalation:
      `sql
SELECT status, pending_thread_id, pending_kind FROM workflow_runs WHERE run_id = '<runId>';
`
      Expect `status = 'suspended'`, `pending_kind = 'user.input'`, and `pending_thread_id` equal
      to the **launching** thread's id.
- [ ] **DB:** `workflow_journal` now has a `resolved` entry for the agent turn's correlation, and a
      new `sent` entry for `user.input`.
- [ ] **UI/stream:** the launching thread shows the escalation question
      (`Merge "Fix the billing rounding bug"? …`) carrying the agent's summary — **confirm the
      summary text is the real assistant output, not blank.** A blank summary is the Part 1
      empty-text regression; it means the reactor resolved the turn with the marker event's empty
      text instead of the assembled delta text.

### 3. User replies → reactor resumes → run completes

- [ ] Reply in the launching thread with a value the `Decision` schema accepts (the recipe asks the
      agent/user to answer with `{ "merge": true }` / `{ "merge": false }`; a real assistant or a
      user typing the JSON both work because the SDK coerces a JSON string reply).
- [ ] **Logs:** no reactor warning; the run resumed and settled.
- [ ] **DB:** the run completed:
      `sql
SELECT status, pending_thread_id, pending_correlation_id FROM workflow_runs WHERE run_id = '<runId>';
`
      Expect `status = 'completed'`, and the pending columns cleared (`NULL`).
- [ ] **DB:** `workflow_journal` has a second `resolved` entry (for the `user.input` correlation).
- [ ] **Result:** the validated output is `{ summary: <the agent's summary>, merged: <bool> }`.
      Confirm it reflects the real reply (e.g. `merged: true` when you replied to merge).

### 4. Restart durability (optional but recommended)

- [ ] Launch again, stop at the `askUser` suspension (step 2 state), then **restart the server**.
- [ ] On boot, `rehydrateSuspendedWorkflowRuns` re-registers the parked run (look for the
      `rehydrated suspended workflow runs` log line with a non-zero `restored` count).
- [ ] Reply in the launching thread → the run resumes and completes exactly as in step 3, proving
      the parked run survived the restart purely from the DB-backed journal + run record.

## Sign-off

The engine is "live-proven" when steps 1–3 pass against a real provider with **no manual
intervention** beyond launching and replying — specifically: the agent-turn resolution and the
user-input resolution were both driven by the production reactor off real domain events, and the
escalation carried the **real** (non-empty) assistant summary.

| Check                                                            | Result | Notes                  |
| ---------------------------------------------------------------- | ------ | ---------------------- |
| Provider / build                                                 |        | provider kind + commit |
| Step 1 — suspend on agent turn                                   |        |                        |
| Step 2 — reactor resumes, advances to askUser, summary non-empty |        |                        |
| Step 3 — user reply resumes, run completes with validated result |        |                        |
| Step 4 — restart durability (optional)                           |        |                        |

> Out of scope for this gate (Phase A): UI rendering polish (Phase C) and thread-deletion cascade
> (Phase B). If the escalation/agent-turn UI looks rough, **note it here, do not fix it in this phase.**
