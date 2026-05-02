# Codex Auth Refresh And Send QA

Date: 2026-04-07
Repo: `/Users/canal/.codex/worktrees/1cce/t3code`
Desktop state: `~/.t3/userdata`
Build under test: local desktop rebuild from this worktree

## Scope

Verify the reported auth-refresh/send failure:

1. The visible provider refresh control should complete instead of spinning forever.
2. A resend on a previously errored Codex thread should recover instead of inheriting the stale `Quota exceeded` session state.
3. A brand-new Codex thread should still send and receive a response normally.

## Inventory

- Visible settings refresh on the running desktop app
- Existing errored thread recovery via the live orchestration websocket
- Fresh thread send via the live orchestration websocket

## Environment

- Desktop app launched with `bun run start:desktop:main-state`
- Live ports from the patched launch:
  - `http://127.0.0.1:61902`
  - `http://127.0.0.1:61903`
- Codex provider reported `Authenticated · ChatGPT Pro Subscription`

## Results

### 1. Visible refresh control

Status: Passed

Steps:

1. Opened `http://127.0.0.1:61903/settings/general`
2. Clicked `Refresh provider status`
3. Waited for the checked timestamp to update

Evidence:

- Page text updated to `Checked just now`
- Provider row still showed `Codex v0.118.0`
- Auth label still showed `Authenticated · ChatGPT Pro Subscription`
- Refresh button was re-enabled after completion

### 2. Existing errored thread recovery

Status: Passed

Target thread:

- Thread id: `a7172a15-7002-4de4-8942-221f1ce58f9c`
- Existing title: `test123`
- Previous persisted state before retry:
  - session status: `error`
  - last error: `Quota exceeded. Check your plan and billing details.`

Action:

- Dispatched a new `thread.turn.start` against that same thread with:
  - user text: `Reply with exactly OK. QA_AUTH_RETRY_1775590365845`

Observed outcome:

- Provider log showed a fresh session restart:
  - `session/connecting`
  - `session/threadOpenRequested` with `Attempting to resume thread 019d6909-55e7-7e00-adb6-ef516eea229c.`
  - `session/threadOpenResolved`
- Persisted session row moved to:
  - status: `ready`
  - last_error: `NULL`
  - updated_at: `2026-04-07T19:32:56.517Z`
- Persisted messages now include:
  - user: `Reply with exactly OK. QA_AUTH_RETRY_1775590365845`
  - assistant: `OK`

Interpretation:

- This is the exact stale-session recovery path we needed.
- The old errored thread no longer stays poisoned after a resend.

### 3. Fresh thread send

Status: Passed

Target thread:

- Project id: `2dd348e7-e576-411c-98ba-dd161318420a` (`t3code`)
- New thread id: `c244983d-5fb8-44dc-9941-0f63d57429d4`
- Title: `QA_AUTH_FRESH_1775590432926`

Action:

1. Created a new thread in `t3code`
2. Sent:
   - `Reply with exactly OK. QA_AUTH_FRESH_1775590432926`

Observed outcome:

- Provider log showed a fresh Codex thread start
- Persisted session row ended in:
  - status: `ready`
  - last_error: `NULL`
  - updated_at: `2026-04-07T19:34:02.480Z`
- Persisted messages now include:
  - user: `Reply with exactly OK. QA_AUTH_FRESH_1775590432926`
  - assistant: `OK`

## Ship Readiness

Passed:

- Visible provider refresh control
- Existing errored-thread resend recovery
- Fresh thread send/response

Not directly verified:

- The exact same click path inside the Electron sidebar/composer chrome, because this desktop shell was still rendering the empty `No projects yet` sidebar state in automation even while the underlying state DB and websocket server were healthy.

Residual risk:

- There may still be a separate Electron/sidebar state hydration issue, but the auth refresh path and the Codex send/recovery path both behaved correctly against the patched backend/runtime.
