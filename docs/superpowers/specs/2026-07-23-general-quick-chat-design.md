# General Workspace Quick Chat (SER-139)

## Context

Every SergeCode thread is attached to a project with a workspace root. That
forces a project pick (or folder browse) before any free-form chat. Users need
a one-click path for general threads that are not tied to a coding repo.

Linear: [SER-139](https://linear.app/sergedev/issue/SER-139/need-a-quick-chatoption-to-start-threads-in-a-general-location-like).

## Goals

- Start a general agent session without choosing a project.
- Land threads in a fixed, auto-created workspace on this Mac.
- Keep the existing New Session flow for project-targeted work.
- Ship macOS only in v1.

## Non-goals

- True project-less threads (no `projectId` in the protocol).
- Mobile UI.
- Settings override for the General path.
- Special project kind / sidebar section.
- Initializing git inside the General folder.

## Approach

**Client-side General project + Quick Chat.** Reuse `project.create` and
`createSceneThread`. No contract changes.

## Workspace

| Field | Value |
|--------|--------|
| Path | `~/Documents/SergeCode/General` (tilde-expanded) |
| Project title | `General` |
| Create missing dir | `createWorkspaceRootIfMissing: true` |

Match an existing project by **normalized workspace path** (expand `~`,
standardize, strip trailing slashes). Reuse it; do not create a second project
for the same path.

## Behavior

1. Resolve preferred provider:
   - Provider of the most recently updated active thread, if still runnable.
   - Else first runnable provider (`ProviderKind.allCases` order).
   - Else set `lastError` with a providers-readiness message and stop.
2. Ensure the General project exists (create if needed).
3. `createSceneThread` with scenery/passport (same as other sessions).
4. Select the new thread on the local device.

Quick Chat always targets **this Mac** (`multi.local`). The General path is
host-local; remotes keep using New Session.

Worktree mode is unchanged: non-git workspaces already skip worktree creation.

## UI (macOS)

| Surface | Control |
|---------|---------|
| Empty state | **Quick Chat** (primary) + **New Session** |
| Toolbar `+` menu | **Quick Chat** above **Choose Target…** |
| File menu (`.newItem`) | **Quick Chat** (`⌘⇧N`) + existing **New Session** (`⌘N`) |

New Session sheet is unchanged.

## Implementation units

1. `GeneralWorkspace` — path constant, normalize/match helpers.
2. `BackendService.addProject(path:createWorkspaceRootIfMissing:)` — plumb flag
   through Live/Mock backends.
3. `AppModel.ensureGeneralProject()`, `preferredQuickChatProvider`,
   `startQuickChat(scenery:passport:)`.
4. Wire EmptyStateView, RootView menu, App command menu.
5. Unit tests for path match, ensure-or-reuse, provider preference.

## Testing

- Pure path normalization / match cases.
- `ensureGeneralProject` reuses existing project at the General path.
- `ensureGeneralProject` creates once when missing.
- `preferredQuickChatProvider` prefers last-used runnable provider.
- Quick Chat fails clearly when no provider is ready.

## Future (out of scope)

- Configurable General path in Settings.
- Mobile Quick Chat reusing the same ensure semantics on the host.
- Optional `kind: general` for dedicated sidebar treatment.
