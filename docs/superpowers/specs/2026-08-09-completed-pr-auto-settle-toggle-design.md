# Configurable completed-PR auto-settlement

## Problem

T3 Code currently has two independent automatic settlement rules:

1. inactivity past `sidebarAutoSettleAfterDays`; and
2. a matching pull request or merge request reaching `merged` or `closed`.

Disabling inactivity settlement does not disable the second rule. Users who want a manual-only
thread lifecycle therefore still see completed-PR threads move to Settled automatically. Reused
branches make this especially disruptive because a historical terminal pull request can affect
every new thread on that branch.

## Required behavior

- Add a separate **Auto-settle completed pull requests** setting.
- The setting defaults to enabled so existing installations keep their current behavior.
- When enabled, merged and closed change requests retain the current immediate auto-settlement
  behavior.
- When disabled, merged and closed change requests do not auto-settle a thread. They continue to
  display their status and the thread follows only the inactivity and explicit-settlement rules.
- Open change requests continue to block inactivity settlement regardless of this setting.
- When both automatic settings are disabled, only an explicit user Settle action can settle a
  thread.
- Web, desktop, iOS, and Android expose and apply the same setting semantics.
- No settle/unsettle, pin/unpin, snooze, or activity-reset semantics change as part of this work.

## Design

### Setting contract

Add the boolean client preference `sidebarAutoSettleCompletedChangeRequests` to the unified settings
contract with a decoding default of `true`. Add it to the client settings patch and persistence
allowlists so older settings files decode to the compatible default and newer values survive app
restart.

The current settlement policy is client-derived on `main`, so the preference belongs beside the
existing client-side inactivity preference for this focused fix. Web/desktop persist it through
client settings. Mobile persists the same boolean through its device preference store and includes
it in the unified settings value used by the thread list.

The pending server-authored settlement refactor is outside this PR. When that refactor lands, both
automatic settlement preferences must move together to server-owned policy so multiple devices
cannot disagree.

### Shared settlement policy

Extend `effectiveSettled` with an `autoSettleCompletedChangeRequests` boolean option. Preserve the
existing precedence:

1. pending work and live sessions keep a thread active;
2. explicit `settled` and `active` overrides win;
3. a terminal change request settles only when the new boolean is `true`;
4. an open change request blocks the inactivity path;
5. inactivity settlement applies only when its day setting is non-null and expired.

Every caller must pass the setting explicitly. This prevents web, chat banners, context menus, and
mobile lists from silently diverging through an implicit fallback.

### Settings surfaces

Web and desktop add a switch to the existing sidebar/thread organization settings near the
inactivity control. Mobile adds the equivalent switch to its settings route. Search metadata must
include the new label so the web settings search can find it.

Copy:

- Label: **Auto-settle completed pull requests**
- Description: **Move threads to Settled when their pull request is merged or closed. Turn this off
  to keep completed pull-request threads active until you settle them or the inactivity rule
  applies.**

### Data flow

1. The user changes the switch on a client.
2. Client settings persistence stores the boolean.
3. Sidebar and active-thread callers pass it to `effectiveSettled` with the current change-request
   state.
4. `effectiveSettled` ignores terminal states when the switch is off while preserving open-PR and
   inactivity behavior.

No contract crossing the T3 WebSocket, database migration, orchestration event, provider adapter,
or VCS polling behavior changes.

## Compatibility and failure behavior

Missing settings values decode to `true`, preserving current behavior after upgrade. A failed
client-settings write follows the existing settings error path and leaves the last persisted value
in effect. The setting never hides or rewrites pull-request status; it controls only automatic
settlement classification.

This PR deliberately does not make a manual `active` override sticky across activity. PR #5643
combined that lifecycle change with the toggle and received a valid review finding: pinning a
settled thread also creates the same active override, so making it sticky can leave an unpinned
thread permanently immune to automatic settlement. Keeping the toggle independent avoids that
regression and keeps one concern per PR.

## Testing

- Contract tests verify the default is `true`, patches accept both boolean values, and persisted
  client settings retain `false`.
- Client-runtime tests verify terminal states settle when enabled and remain active when disabled.
- Client-runtime tests verify open change requests still block inactivity when the toggle is off.
- A manual-only test combines `autoSettleCompletedChangeRequests: false` with
  `autoSettleAfterDays: null` and proves only `settledOverride: "settled"` settles the thread.
- Web tests cover settings search and every `effectiveSettled` call site through typechecking.
- Mobile preference and thread-list tests cover persistence and both toggle values.
- Focused typechecks cover contracts, client runtime, web, desktop, and mobile.

## User documentation

Update `docs/user/thread-sidebar.md` to describe the two independent automatic rules and how to
disable both for a manual-only workflow.

## Relationship to existing work

PR #5643 implements the same user-facing toggle but is currently conflicting with `main` and also
contains the unrelated sticky-Un-settle change described above. The implementation should preserve
credit for that contribution while producing a clean, current, single-concern change. Issue #4970
continues to track the separate historical-branch association bug.

## Out of scope

- Determining whether a terminal pull request predates a thread.
- Changing the default from enabled to disabled.
- Moving client-derived settlement to the server.
- Changing explicit settle/unsettle lifecycle semantics.
