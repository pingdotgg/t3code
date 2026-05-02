# Queue + Steer Deep QA - 2026-05-02

## Scope

Exhaustive-ish Electron QA for queue and steer behavior on `codex/rebuild-feature-rollout`, focused on active-turn queueing, queue row controls, keyboard shortcuts, steer behavior, and a reproduced send-now gating bug.

## Environment

- App: Electron production build from `bun run start:desktop`
- Profile: `/tmp/t3code-electron-qa-home-queue-steer-deep` before the fix, `/tmp/t3code-electron-qa-home-queue-steer-fixed` after the fix, `/tmp/t3code-electron-qa-home-queue-steer-clear` for final clear-all QA
- QA project: `/tmp/qa-project-queue-steer-deep`
- Browser backend: Computer Use driving the Electron window

## Manual Scenarios

| Scenario                                         | Result            | Evidence                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue via `Tab` during an active `sleep 90` turn | Failed before fix | Panel showed `Ready to dispatch in order.` and enabled `Send queued follow-up now` while the turn was still running. Clicking it sent the queued item immediately instead of waiting.                                                                                                               |
| FIFO auto-dispatch after active turn settles     | Pass              | During `sleep 75`, queued A by `Tab` and B by Queue button. After `SECOND_BASELINE_DONE`, A dispatched and returned `A_DONE`, then B dispatched and returned `B_DONE`.                                                                                                                              |
| Row move buttons                                 | Pass              | During `sleep 120`, queued C and D, moved D up via row button, and observed D become `Next up`.                                                                                                                                                                                                     |
| `Alt+Up` / `Alt+Down` row focus                  | Pass              | Focus moved between queued rows in the Electron accessibility tree.                                                                                                                                                                                                                                 |
| `Alt+Shift+Up` / `Alt+Shift+Down` reorder        | Pass              | Focused row reordered up/down and the visible `Next up` row changed accordingly.                                                                                                                                                                                                                    |
| Edit queued item                                 | Pass              | Edited C to `Queue item C edited: reply exactly C_EDITED_DONE.` and saved; edited text remained in the queued row.                                                                                                                                                                                  |
| Save queued item as snippet                      | Pass              | `Save queued follow-up as snippet` displayed `Saved to snippets`.                                                                                                                                                                                                                                   |
| Remove queued item                               | Pass              | Removed D, queue count dropped from 2 to 1, and only edited C remained.                                                                                                                                                                                                                             |
| Edited queued item auto-dispatch                 | Pass              | After `THIRD_BASELINE_DONE`, only edited C dispatched and returned `C_EDITED_DONE`; removed D did not dispatch.                                                                                                                                                                                     |
| Fixed running-turn send-now gate                 | Pass after fix    | During `sleep 45`, queued follow-up panel showed `Waiting for the current turn to settle.` and `Send queued follow-up now` was disabled. After `FIXED_BASELINE_DONE`, the queued item dispatched and returned `FIXED_QUEUE_DONE`.                                                                   |
| Steer during active turn                         | Pass              | During `sleep 60`, sent steering message as a normal user bubble while the turn was Working; no queue panel appeared, and final response used steered marker `CLEAN_STEER_DONE`.                                                                                                                    |
| Clear all during active turn                     | Pass              | During `sleep 180`, queued A and B, observed `2 queued follow-ups` and disabled send-now buttons, clicked `Clear all`, and the queue panel disappeared while the baseline was still Working. After settle, only `CLEAR_BASELINE_DONE` appeared; neither `BAD_CLEAR_A` nor `BAD_CLEAR_B` dispatched. |

## Reproduced Bug

Before the fix, the queue panel used a weaker `canSendNow` predicate than auto-dispatch. While a turn was `running`, the panel still said `Ready to dispatch in order.` and the `Send queued follow-up now` button was enabled. Clicking it consumed the queued item and dispatched it immediately, effectively turning a queued follow-up into a steer-like message.

## Fix Verification

- `ChatView` now gates queued dispatch on the same active-turn blockers used by auto-dispatch: running phase, local send busy, reconnecting, send-in-flight, active queue dispatch, pending approval, pending user input, and pending progress.
- `dispatchQueuedTurn` also refuses to dispatch while the thread is running or blocked by pending approval/input/progress.
- Browser regression test now asserts that a running turn shows `Waiting for the current turn to settle.` and disables `Send queued follow-up now`.
- Browser regression test now covers clearing multiple queued follow-ups during a running turn, settling the thread, and verifying that no cleared follow-up dispatches.

## Automated Checks

- `bun run --cwd apps/web test:browser src/components/ChatView.browser.tsx -t "shows queue controls during a running turn"`: passed
- `bun run --cwd apps/web test:browser src/components/ChatView.browser.tsx -t "queued follow-ups"`: passed
- `bun fmt`: passed
- `bun lint`: passed with pre-existing warnings only
- `bun typecheck`: passed
- `bun run test`: passed, 9 turbo tasks successful

## Residual Risks

- I did not repeat the full WiFi/server-kill universal regression suite in this pass; this QA pass was intentionally scoped to queue and steer behavior.
