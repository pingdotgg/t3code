---
name: verify-side-chat-lifecycle
description: Model-check that a T3 Learn side chat is finished exactly once and leaves nothing queued or running, using a TLA+ model and TLC. Use after any change to Done, Discard, auto-finish on a sent message, reopen, Stop or queued runs, or the side-chat outcome note in apps/server/src/orchestration-v2.
---

# Verify the side-chat lifecycle

**Property.** Each time a side chat is open, it is finished at most once, it gets the note from that finish, and a note being written always settles. Once it is finished, nothing is queued in it and no turn runs in it, except one that is being stopped.

**Harm if broken.** A finished chat writes a second note or loses its first one, the lesson gets a note about another round, or a turn keeps working in a chat the learner closed, and its answer reaches no note.

This complements [verify-side-chats](../verify-side-chats/SKILL.md), which drives the UI. This skill checks every order of the commands below in seconds, and needs no server.

## Run it

```bash
.agents/skills/verify-side-chat-lifecycle/run.sh                    # expect: No error has been found
.agents/skills/verify-side-chat-lifecycle/run.sh --external-sends   # expect: the known finding below
```

The script fetches TLC (tla2tools 1.7.4, sha256-pinned) into `~/.local/share/tla/` the first time, then runs under a 2 GB memory cap. It needs Java 11 or later. The default run explores about 119k states in about 15 s.

## What the model is

`SideChatLifecycle.tla` covers a lesson L with side chat A, and side chat B nested under A. Each action is one orchestrator command. Commands commit atomically under the lesson's lock (`sideChatLessonLockThreadId`), so one action is one step. The provider and the effect worker get their own steps. All refs are to `apps/server/src/orchestration-v2/Orchestrator.ts` unless the table says otherwise.

| Model                       | Code                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Done(c)`                   | `dispatchSideChatDone` (not discard): open descendants first, then `stopSideChatRun` and `finishSideChat`; already done is a no-op                                        |
| `Finish`                    | `finishSideChat`: `done.outcome = generating` with a new `sideChatOutcomeRequestId`, plus a `side-chat.outcome` effect                                                    |
| `StopRun`                   | `stopSideChatRun`: `thread.stop` only records an interrupt request (`markStoppedRun`); queued runs are cancelled                                                          |
| `UserSend(c)`, `LessonSend` | `message.dispatch` → `applySideChatUserMessage` (`reopenDoneSideChats`, then idle open side chats below finish; `keptOpen`), then `dispatchMessage` (`heldRunsToRelease`) |
| `ExternalSend(c)`           | `message.dispatch` that `isUserAuthoredSideChatTrigger` (`sideChat/notes.ts`) rejects: scheduled task, notification, delegated completion, agent                          |
| `Stop(c)`                   | `thread.stop` on an open side chat: `holdStoppedThread` sets `queueHeld`                                                                                                  |
| `RunEnds`, `QueuedStarts`   | the provider ends a run; the next unheld queued run starts                                                                                                                |
| `OutcomeComplete(e)`        | `SideChatLifecycleService.writeOutcome` (`sideChat/SideChatLifecycleService.ts`) → `dispatchSideChatOutcomeComplete`: lands only on the matching `generating` request     |

Invariants are `FinishedOnce`, `OwnOutcome` and `NothingLeftWhenDone`. `NoteSettles` is a liveness property, under fairness for the provider and the effect worker.

**Bounds and assumptions.** There are 2 side chats, at most 2 queued runs each, and 6 finishes in total (`MaxRequests = 7`). Every side chat already has a user message, because an empty one is deleted, not finished. Discard and delete, archive, the note's text and nested-note delivery are left out. So are the wait cap, the steer and promote paths, and provider failures that re-hold a queue. A pass covers this model at these bounds, not the system.

## Known finding (2026-11-04, filed as APP-22)

`run.sh --external-sends` fails `NothingLeftWhenDone`:

1. The learner presses Done on A. A is `generating`, then `ready`.
2. A message that is not the learner's own reaches A, for example a scheduled task bound to A, or a delegated task's completion. `applySideChatUserMessage` returns early, so A does not reopen, and `dispatchMessage` starts a turn.
3. A is done with a running turn. A lesson message skips it, because it is done, so the answer is in no note.

Reproduced on real code with the side-chat test harness: after Done, `harness.send(space, "[hold] …", { scheduledTaskId })` leaves `done.outcome.status = "ready"` with runs `["completed","running"]`. The default run leaves `ExternalSends` off so it checks the rest clean. When APP-22 is fixed, make `--external-sends` the default by setting `ExternalSends = TRUE` in the `.cfg` and deleting the flag from `run.sh`.

## Reading a result

Read every result with pstack's `/statechart` skill. It tells a violation's shortest path in plain words, and it draws the state chart when the check passes. Map each step's action name back to the table above.

- **Real bug:** each step in the trace is something the code allows, and you can find the same order in the code, or reproduce it in `testkit/SideChatDone.integration.test.ts` with `makeSideChatHarness`. Report it with the steps in code words, and don't weaken the model.
- **Modeling error:** a step does something the code can't, such as an action that ignores a guard the code has, or two code commands merged into one action. Fix the model to match the code, and record why in the PR.
- `Temporal properties were violated` means a note can stay `generating` forever. Check that `Finish` still adds its effect, and that fairness still covers `OutcomeComplete`.

## Proof that it can fail (2026-11-04, model at a82fb05fa9)

Each of these one-line breaks in the model fails the check. Rerun one after editing the model, to show the check still bites:

| Break                                                            | Fails                                        |
| ---------------------------------------------------------------- | -------------------------------------------- |
| `Done` without the already-done no-op (the seeded double finish) | `FinishedOnce` in 2 steps                    |
| `OutcomeComplete` without `req[c] = e[2]`                        | `OwnOutcome`                                 |
| `AutoFinishBelow` without `s.queued[c] > 0`                      | `NothingLeftWhenDone` (Stop holds the queue) |
| `Done` without `StopRun`                                         | `NothingLeftWhenDone`                        |
| `Finish` without adding to `pending`                             | `NoteSettles`                                |

The same double finish in real code (guard at `if (sideChat.done !== null)` in `dispatchSideChatDone` removed) also fails `a stale outcome completion is dropped and pressing Done twice keeps the first outcome` in `SideChatDone.integration.test.ts`. Removing `keptOpen` passes. It guards a different property, that no side chat is open below a done one, which this model doesn't check.

## Keeping it in step

**Covered code**, all in `apps/server/src/orchestration-v2/`:

- `Orchestrator.ts`: `finishSideChat`, `stopSideChatRun`, `dispatchSideChatDone`, `dispatchSideChatOutcomeComplete`, `reopenDoneSideChats`, `applySideChatUserMessage`, the `message.dispatch` case, the queue hold and release in `dispatchMessage`, `holdStoppedThread`, `markStoppedRun`, `sideChatLessonLockThreadId`.
- `sideChat/SideChatLifecycleService.ts`: `writeOutcome`.
- `sideChat/notes.ts`: `isUserAuthoredSideChatTrigger`.
- `sideChat/tree.ts`: `sideChatOutcomeRequestId`.

**Sync commit: a82fb05fa9.** To see whether the model needs another look:

```bash
git diff a82fb05fa9 -- apps/server/src/orchestration-v2/Orchestrator.ts apps/server/src/orchestration-v2/sideChat/
```

Then grep the diff for the functions above. If one of them changed, update the model or its table row, rerun both modes, and rerun one break from the proof table. Move the sync commit forward, here and in the proof heading, only after you have confirmed the model describes the code at the new commit. A change that adds a way to finish, reopen, queue or start a turn in a side chat needs a new action, not only a rerun.
