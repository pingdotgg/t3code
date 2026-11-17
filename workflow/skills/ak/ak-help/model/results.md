# Results: before and after the ten fixes

Assembled from `run.sh` output. Before: the first model against the skills at commit f8850d5d61. After: this model against the skills as they stand now, which also covers `maestro-worker` shipping through `full-send`, the heartbeat that stays on while an issue is `needs-help` or blocked, and the first tick reaping a `needs-help` orphan.

## TLC rules on Pipeline.cfg

421,614 states before, 643,027 after (the extra states are the epic, the 3-round replan counter, `implement-spec`'s ticket set, the week-old claims and the `full-send` steps of bcheck).

| rule                     | before          | after                                       |
| ------------------------ | --------------- | ------------------------------------------- |
| `BcheckLeavesHumanTasks` | FAIL (8 steps)  | PASS: gap 7, the search excludes them       |
| `NoDoubleWork`           | FAIL (7 steps)  | FAIL (7 steps): still open, see below       |
| `NeverClaimBlocked`      | PASS            | PASS                                        |
| `NoSpecDispatch`         | FAIL (6 steps)  | PASS: gap 1, the spec is an `epic`          |
| `PlanFiledApproved`      | FAIL (5 steps)  | PASS: gap 2, the user approves the change   |
| `ClaimsReleased`         | FAIL (11 steps) | PASS: gap 8, week-old claims are unassigned |
| `FogHasTicket`           | FAIL (11 steps) | PASS: gap 9, the user is asked              |
| `NoSleepingFrontier`     | FAIL (5 steps)  | FAIL (11 steps): different cause, see below |

`ClaimsReleased` now says what the text keeps: a claim younger than a week stays, and no ticket session starts with a claim older than a week. `FogHasTicket` counts a claimed ticket as a ticket.

### NoDoubleWork breaks (still open)

Before: a worker runs, then you run implement-spec on the same ticket. After: `implement-spec` skips `in-progress` tickets but never labels the ones it takes, so the claim goes the other way.

The shortest path has 7 steps:

1. you skip straight to filing
2. you hand over your own plan file
3. plan-to-issues finds the plan unaudited and runs replan
4. dependencies are clear
5. epic and tasks created, any maestro thread is nudged
6. you run implement-spec: it takes every ticket that is not `in-progress`, with no label
7. you run bcheck and it claims a ticket: the same ticket is still `ready-for-agent`, so bcheck's search finds it (a maestro dispatch is the same bug)

Cause: `implement-spec` step 1, "Leave out any ticket labelled `in-progress`", with no step that labels what it takes.

### NoSleepingFrontier breaks (different cause)

Before: tickets filed by `plan-to-issues` while a maestro thread slept, with nobody told to wake it (gap 3, fixed). After: the filing nudges, but the epic is left open.

The shortest path has 11 steps:

1. you skip straight to filing
2. you hand over your own plan file
3. plan-to-issues finds the plan unaudited and runs replan
4. dependencies are clear
5. epic and tasks created, any maestro thread is nudged
6. someone nudges the maestro
7. maestro claims a ticket and starts a worker
8. worker merges the PR
9. maestro tells the master a human task is unblocked
10. maestro finds nothing to do and pauses its heartbeat
11. someone does the human task by hand: every ticket is merged, the epic is open, and nothing wakes the maestro

Shorter version without a human task (`ExecChart.cfg`, 6 steps): tickets ready and the maestro asleep, you run bcheck and it judges the ticket ready, it hands over to `full-send`, someone nudges the maestro, the maestro pauses its heartbeat while bcheck works, and `full-send` merges the last ticket.

Cause: maestro "Heartbeat" pauses when the frontier is empty, no worker runs and no issue is `needs-help` or blocked. An open `epic` and an unfinished human task or bcheck ticket do not count, and `full-send` and a person finishing a human task send the maestro nothing. Only the maestro's tick closes the epic.

## NetworkX rules on Graph.cfg

128,982 states and 794,311 edges before, 194,197 states and 988,763 edges after (`MaxRounds = 1`).

| rule                             | before                                                           | after                                                       |
| -------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `EveryStateCanReachMergedOrStop` | PASS                                                             | FAIL: 372 states, epic stays open with no maestro           |
| `FiledStatesCanStillReachMerged` | PASS                                                             | FAIL: 2,120 states, the same cause                          |
| `NoSilentStall`                  | FAIL: 3 dead ends (sleeping maestro, bcheck commit, human tasks) | FAIL: 1 dead end, the open epic with a paused maestro       |
| `NoAgentOnlyLoop`                | FAIL: 1,312 audit and rewrite cycles                             | PASS: gap 10, replan stops after 3 rounds and asks the user |
| `ApprovalsRequireTheUser`        | PASS                                                             | PASS                                                        |
| `RouteReachesMerged[spec]`       | PASS                                                             | PASS                                                        |
| `RouteReachesMerged[plan]`       | PASS                                                             | PASS                                                        |
| `RouteReachesMerged[wayfinder]`  | PASS                                                             | PASS                                                        |

`NoSilentStall` before and after, by cause:

- Tickets ready, maestro asleep, nobody told (before, 5 steps): gone. Gap 3: `to-tickets` and `plan-to-issues` nudge an existing maestro thread.
- bcheck committed and stopped, the in-progress label stays (before, 8 steps, 33 states): gone. Gap 5: bcheck ships through `full-send`, which merges.
- Only ready-for-human tasks left, nobody tells the person (before, 9 steps): gone. Gap 6: the maestro tells the master when one is unblocked.
- Every ticket merged, epic still open, maestro asleep (new, 11 steps, 14 states): same path as `NoSleepingFrontier` above.

### Epic stays open with no maestro (new)

`EveryStateCanReachMergedOrStop` and `FiledStatesCanStillReachMerged` fail on one shortest path of 10 steps, starting with no maestro thread and an idea that does not run under the maestro skill:

1. you skip straight to filing
2. you hand over your own plan file
3. plan-to-issues finds the plan unaudited and runs replan
4. dependencies are clear
5. epic and tasks created: no maestro thread exists, so nobody is nudged
6. you run bcheck and it claims a ticket
7. bcheck judges it ready
8. bcheck implements and hands over to full-send
9. full-send merges the PR and closes the issue
10. someone does the human task by hand: every ticket is merged and the epic is open, and no skill closes it

Cause: `to-spec` and `plan-to-issues` label the parent `epic`, and only `maestro` Dispatcher step 4 closes it. tickets finished by `bcheck` or by hand without a maestro leave it open (`implement-spec`'s PR does close the spec).

## Gaps closed and still open

| gap | skill change                                                               | model after                                                                                         |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | `to-spec` labels the spec `epic`; maestro closes it                        | `NoSpecDispatch` PASS; new epic gap below                                                           |
| 2   | `plan-to-issues` asks again when `replan` changed the plan                 | `PlanFiledApproved` PASS                                                                            |
| 3   | filing skills nudge an existing maestro thread                             | sleeping tickets gone from `NoSilentStall`                                                          |
| 4   | `maestro: claimed`; own orphans only; `implement-spec` skips `in-progress` | the restart case and the worker-first case are gone; `NoDoubleWork` still fails the other way round |
| 5   | `bcheck` ships through `full-send`                                         | bcheck dead end gone                                                                                |
| 6   | maestro announces unblocked human tasks                                    | human-task dead end gone                                                                            |
| 7   | `bcheck` search excludes `ready-for-human`                                 | `BcheckLeavesHumanTasks` PASS                                                                       |
| 8   | `wayfinder` unassigns week-old claims                                      | `ClaimsReleased` PASS                                                                               |
| 9   | `wayfinder` asks about leftover fog                                        | `FogHasTicket` PASS                                                                                 |
| 10  | `replan` stops after 3 rounds                                              | `NoAgentOnlyLoop` PASS                                                                              |

New since the first run, and what the model made of it: the maestro heartbeat staying on while an issue is `needs-help` or blocked keeps a paused maestro from missing a blocker that finishes; the first tick reaping an `in-progress` plus `needs-help` orphan removes the requeue of someone else's claim; `maestro-worker` following `full-send` changes no worker state, since `full-send` ends merged or asking for help.

Still open: `implement-spec` never labels its tickets (`NoDoubleWork`); and the epic stays open when the maestro sleeps or does not exist while the last ticket is finished by hand (`NoSleepingFrontier`, `NoSilentStall`, `FiledStatesCanStillReachMerged`, `EveryStateCanReachMergedOrStop`).
