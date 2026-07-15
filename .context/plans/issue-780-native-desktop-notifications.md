---
type: plan
name: Issue #780 native desktop notifications
description: Small opt-in native notifications for settled thread attention events
planSlug: issue-780-native-desktop-notifications
summary: Derive safe thread transitions in web state and deliver generic native notifications through Electron.
agents: []
docs:
  - architecture.md
  - data-flow.md
  - development-workflow.md
  - testing-strategy.md
phases:
  - id: planning
    name: Planning
    prevc: P
    summary: Verify upstream direction, map canonical state, and define a bounded design.
    deliverables:
      - Canonical plan and decision record
    steps:
      - order: 1
        description: Review issue #780 and prior attempts
        assignee: solo-dev
        deliverables: [Upstream research]
      - order: 2
        description: Map shell, settings, IPC, window, and routing sources
        assignee: solo-dev
        deliverables: [Architecture map]
      - order: 3
        description: Define implementation and validation gates
        assignee: solo-dev
        deliverables: [Approved plan]
  - id: review
    name: Review
    prevc: R
    summary: Challenge correctness, privacy, replay, focus, and click-navigation behavior before edits.
    deliverables:
      - Reviewed and approved plan
    steps:
      - order: 1
        description: Review design against acceptance criteria and prior PR failures
        assignee: solo-dev
        deliverables: [Review notes]
  - id: execution
    name: Execution
    prevc: E
    summary: Implement settings, pure derivation, Electron delivery, navigation, and focused tests.
    required_sensors: [test, check, typecheck, diff-check]
    required_artifacts:
      - .context/evidence/issue-780-native-desktop-notifications-validation.md
    deliverables:
      - Production code
      - Focused automated tests
    steps:
      - order: 1
        description: Add default-off persisted desktop preference
        assignee: solo-dev
        deliverables: [Settings schema and UI]
      - order: 2
        description: Add pure settled transition derivation and replay-safe observation
        assignee: solo-dev
        deliverables: [Tracker and tests]
      - order: 3
        description: Add native Electron delivery and focus policy
        assignee: solo-dev
        deliverables: [Desktop service and tests]
      - order: 4
        description: Add click restore, focus, and pending deep-link navigation
        assignee: solo-dev
        deliverables: [IPC and renderer integration]
  - id: validation
    name: Validation
    prevc: V
    summary: Run repository gates, real macOS smoke tests, evidence capture, and draft PR handoff.
    required_sensors: [test, check, typecheck, diff-check]
    required_artifacts:
      - .context/evidence/issue-780-native-desktop-notifications-validation.md
      - .context/handoffs/issue-780-native-desktop-notifications-pr.md
    deliverables:
      - Validation evidence
      - Screenshots or video
      - Draft pull request
    steps:
      - order: 1
        description: Run focused tests and required repository gates
        assignee: solo-dev
        deliverables: [Command evidence]
      - order: 2
        description: Run real macOS desktop smoke matrix
        assignee: solo-dev
        deliverables: [Smoke evidence]
      - order: 3
        description: Commit, push origin, open draft PR, and record handoff
        assignee: solo-dev
        deliverables: [Draft PR URL and handoff]
generated: "2026-07-15"
status: filled
progress: 27
scaffoldVersion: "2.0.0"
lastUpdated: "2026-07-15T00:45:28.704Z"
---

# Issue #780 native desktop notifications

## Goal

Notify only opted-in desktop users when a live, non-archived thread settles or newly needs attention while T3 Code is not focused. Notification content remains generic. Clicking restores or creates the app window and navigates to the exact environment/thread.

## Upstream state

- Issue #780 remains open.
- No maintainer reply after `obrunogonzaga`'s latest issue comment requests a pause or changes direction.
- PRs #976, #1657, and #1780 are closed; PR #2373 remains unmerged.
- No code or dependency will be copied from an unmerged PR. Only compatible failure lessons inform this plan.

## Design

1. Extend persisted client settings with `desktopNotificationsEnabled`, decoded as `false` for old documents and restored to `false` by defaults.
2. Observe environment-scoped `OrchestrationThreadShell` state only after settings hydration and live shell synchronization.
3. Purely derive four generic events: settled completion, settled failure, new approval, and new user input.
4. Reset/baseline the tracker during bootstrap, reconnect, replay, and reseed. Require a real running-to-settled turn transition and rising pending flags.
5. Suppress archived/removed threads and generate stable event IDs for renderer and main-process deduplication.
6. Send only kind, event ID, environment ID, and thread ID over the preload bridge.
7. In Electron main, recheck persisted opt-in, `Notification.isSupported()`, dedupe, and actual `BrowserWindow` focus immediately before showing a silent native notification.
8. Treat native delivery failure, including denied permission or unsigned development builds, as a non-fatal skipped result.
9. On click, store a pending route, reveal or create the main window, focus the app, notify the renderer, then consume the route exactly once.

## Fixed copy

- Title: `T3 Code needs your attention`
- Completion: `A turn completed.`
- Failure: `A turn failed.`
- Approval: `An approval is required.`
- Input: `Your response is required.`

No dynamic title, response, prompt, diff, command, project name, or thread title is included.

## Tests

- Bootstrap, reconnect, replay, reseed, stable state, archived/removed state, and partial snapshots produce no false alert.
- `running -> completed` and `running -> error` emit once.
- Approval/input rising edges emit once.
- Disabled settings, focused window, unsupported API, denied/failed delivery, and duplicate IDs do not notify or throw.
- Click reveals/focuses and resolves the correct environment/thread route once.
- Legacy settings and restore defaults leave the preference disabled.

## Validation and handoff

- Run focused tests throughout implementation.
- Run `vp test`, `vp check`, and `vp run typecheck`.
- Smoke the required macOS matrix and record limitations in `.context/evidence/issue-780-native-desktop-notifications-validation.md`.
- Capture configuration and notification screenshots or video.
- Commit with concise conventional commits, push only to `origin`, and open a draft PR against `pingdotgg/t3code:main` with `Closes #780`.
- Record the final handoff in `.context/handoffs/issue-780-native-desktop-notifications-pr.md`. Do not merge.

## Risks

- macOS native delivery requires a signed app. Use the packaged signed build for smoke validation; record any development-build limitation honestly.
- Stream replay may resemble live updates. Explicit synchronization generations and baselines must gate transition derivation.
- Renderer reload can repeat derived events. Stable IDs plus bounded main-process deduplication prevent duplicate delivery while the desktop process lives.
- Notification clicks can race renderer startup. Pending navigation is stored main-side and consumed after the route is ready.

## Out of scope

Sounds, pets, overlays, tray/menu-bar UI, generic hooks, remote push, daemons, mobile changes, and notifications after the desktop process fully exits.

## Unresolved questions

None.

## Execution History

> Last updated: 2026-07-15T00:45:28.704Z | Progress: 27%

### planning [DONE]
- Started: 2026-07-15T00:45:28.430Z
- Completed: 2026-07-15T00:45:28.704Z

- [x] Step 1: Review issue *(2026-07-15T00:45:28.430Z)*
  - Notes: Issue and prior PR state reviewed; no new maintainer stop or direction change.
- [x] Step 2: Map shell, settings, IPC, window, and routing sources *(2026-07-15T00:45:28.583Z)*
  - Notes: Mapped shell/projector, settings persistence, Electron window/IPC, and environment-thread routing.
- [x] Step 3: Define implementation and validation gates *(2026-07-15T00:45:28.704Z)*
  - Notes: Canonical design, acceptance matrix, sensors, evidence, and PR boundaries recorded.
