# Machine-aware grouped project profiles

## Status

Approved in chat on 2026-08-18. This specification expands the existing
grouped-project environment picker into a complete draft-only machine profile
flow.

## Problem

T3 Code can now recognize matching repository projects across environments and
lets a new draft switch between them. The current switch only changes the
physical project reference. It does not expose the target machine's path or
execution context, and it drops branch/worktree context instead of remembering
one context per machine. A user who works on the same repository from a laptop
and a Mini PC needs one predictable project row while retaining each machine's
own checkout, worktree, model, and composer choices.

## Goals

1. Present each matching environment as an explicit machine profile in the
   bottom-left `Run on` picker.
2. Show the target project's workspace path, checkout/branch, worktree state,
   provider/model, and draft execution settings before switching.
3. Keep draft context isolated by physical environment/project so switching
   from machine A to machine B and back restores each machine's choices.
4. Use the selected environment and physical project as the source of truth
   when the new thread is created.
5. Keep environment selection available only for new, unstarted threads.
6. Preserve existing grouped-project behavior, separate-project overrides,
   single-environment behavior, and remote/tunnel connection behavior.

## Non-goals

- Do not add server or WebSocket contracts. Profiles are draft-local client
  state; the created server thread already stores its selected environment,
  project, model, runtime mode, interaction mode, branch, and worktree.
- Do not expose credentials, environment variables, or the full Settings page
  inside the picker. “Settings” here means the execution settings already
  attached to a draft: provider/model, runtime mode, interaction mode, and
  start-from-origin.
- Do not move an existing server thread between machines. Its environment and
  workspace remain immutable once the thread has started.
- Do not change mobile navigation in this pass. Mobile already has a grouped
  environment/workspace menu; the shared draft/profile logic must remain
  compatible with it.

## User experience

### Machine picker

The desktop composer context strip retains the existing `Run on` trigger. Its
anchored popup contains one compact row per environment in the logical project:

- environment icon and label, with a primary/remote distinction;
- repository path (`workspaceRoot`), truncated visually with the full value in
  the title/accessible description;
- checkout row: the saved branch when this draft has visited the machine,
  otherwise `Current checkout`;
- workspace row: `Current checkout`, `New worktree`, or the saved worktree path;
- provider and model row, falling back to the physical project's default model;
- execution row with runtime mode, interaction mode, and start-from-origin;
- connection state for a remote environment. Unavailable environments remain
  visible but are disabled and labeled unavailable.

The popup is collision-aware and remains anchored to the bottom composer. The
mobile menu continues to open upward and may use the same profile row content
where its width permits.

The existing adjacent workspace selector and branch selector remain usable.
Selecting a machine updates both controls to the selected profile. The machine
row is a summary, not a second independent branch/worktree editor.

### Switching and locking

When the current route is a draft and the thread has not started, selecting a
machine atomically:

1. snapshots the current physical project's draft context and composer model
   choices into its profile;
2. selects the target environment/project reference;
3. restores the target profile if one exists;
4. otherwise clears machine-local branch/worktree/model overrides so the target
   project's checkout and defaults are used, while retaining the user's
   intentional runtime/interaction mode where no target override exists.

Once the active thread has messages or an active session, the selector becomes
static. The existing `envLocked` behavior remains the guard used by both the UI
and the callback.

## Data model and persistence

Add a `MachineDraftProfile` value to the persisted draft-session state. Profiles
are keyed by a stable physical project key (`environmentId:projectId`), not by a
machine label or path, so labels can change without losing state.

```ts
type MachineDraftProfile = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  activeProvider: ProviderInstanceId | null;
};
```

The active `DraftSessionState` remains the fast path for existing consumers.
The profile map is updated atomically by the draft-store context switch and by
normal branch/model/mode changes. Existing persisted drafts decode with an empty
profile map and continue to behave as before until the user switches machines.
When restoring a profile, model selections are filtered through the selected
environment's provider list; unavailable provider instances fall back to the
physical project's default model or the normal provider default.

## Data flow

1. `ChatView` derives the logical project's environment/project members as it
   does today.
2. It passes each member plus its draft profile and project default model to
   `BranchToolbar`.
3. `BranchToolbarEnvironmentSelector` renders the profile summary and calls a
   single draft context-switch callback.
4. `ChatView` refuses the callback when `envLocked` is true and otherwise calls
   the draft-store atomic switch method.
5. The active environment/project changes, so existing environment queries,
   provider statuses, git status, model options, file operations, and terminal
   controls rebind to that physical environment.
6. Starting the draft sends the selected environment/project and restored
   execution context through the existing thread bootstrap path.

## Error handling

- Missing project/profile data uses explicit labels (`Current checkout`,
  `Project default`, `Unavailable`) rather than fabricated values.
- A disconnected remote remains selectable only after it reconnects; clicking
  it while unavailable leaves the current profile unchanged and surfaces the
  existing connection status.
- Malformed/legacy profile entries are ignored during decode; the current draft
  remains usable and the next persisted write stores only valid entries.
- Switching never copies a branch or worktree path from one environment into
  another unless that target profile explicitly owns the path.

## Testing strategy

- Draft-store logic tests cover profile snapshot/restore, first visit fallback,
  per-machine model isolation, branch/worktree restoration, legacy payload
  decoding, and the started-thread lock.
- Branch-toolbar logic/component tests cover profile summaries, path truncation
  labels, unavailable entries, primary/remote icons, and popup selection wiring.
- Existing grouped-project and branch-toolbar suites remain green.
- Run focused web tests, web typecheck, targeted lint/format, then one browser
  pass with two isolated servers verifying the popup details, switch A → B → A,
  start-thread payload context, and locked existing-thread behavior.
