# Queue + Steer QA

Date: 2026-04-16
Branch: `codex/rebuild-feature-rollout`

## Environment

- Dev server launched with isolated state via `T3CODE_HOME=/tmp/t3-qa-queue-steer-keTEtW`
- Browser QA executed in Google Chrome through the Computer Use plugin
- Terminal gate passed:
  - `bun fmt`
  - `bun lint`
  - `bun typecheck`
  - `bun run test`
  - `bun run build`
  - `bun run build:desktop`

## Manual QA

### Scenario 1: queue, edit, and auto-dispatch a follow-up

1. Opened a fresh thread in the isolated local app.
2. Sent `Summarize queued follow-up handling in ChatView.`
3. While the first response was still running, typed `Then list the exact functions involved.` and pressed `Tab`.
4. Verified the queued panel appeared above the composer with `1 queued follow-up`.
5. Edited the queued item in place to `List the exact Queue + Steer functions and where each one is called.` and saved it.
6. Waited for the active turn to settle.
7. Verified the queued item auto-dispatched without any extra click and appeared as the next user turn in the thread.

Result: pass

### Scenario 2: steer immediately during an active run

1. While the auto-dispatched queued turn was still running, typed `Also explain how Steer with Enter differs from Queue with Tab.`
2. Pressed `Enter`.
3. Verified the message posted immediately as a live user turn instead of being added back into the queue.

Result: pass

## Observations

- The queue panel correctly exposed edit, send-now, remove, and clear-all controls during the queued state.
- Keyboard-first behavior was validated for the marquee shortcuts:
  - `Tab` queued a follow-up while a turn was running
  - `Enter` steered immediately while a turn was running
- I did not run a full manual tab-order accessibility sweep in this pass; the dedicated browser tests remain the broader regression backstop there.

## Environment note

- Launching the app against the default persisted local state under `~/.t3` failed before QA with `SQLiteError: no such column: latest_user_message_at`.
- Queue + Steer feature QA itself passed on the isolated state directory, so this looks like an existing local-state migration issue rather than a regression introduced by this feature.
