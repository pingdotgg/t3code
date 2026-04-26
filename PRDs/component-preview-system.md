# Component Preview System PRD

## Problem Statement

Forma is currently strong at chat, planning, diffs, and terminal-driven agent workflows, but it does not help users visually inspect the UI components they are actively building. For design-engineering work, this creates a gap: a user can ask an agent to build or refine a `Button`, `Card`, or `Dropdown`, but they cannot immediately see and tune that component in isolation inside Forma. End users are not limited to React experts, so the preview workflow needs to feel predictable, low-friction, and integrated into the normal agent loop instead of requiring manual Storybook setup, route hunting, or external dev-server management.

The feature needs to support design-oriented application development across many projects, not just this repo. That means the preview system must be portable, framework-aware enough to be useful in practice, reliable under thread/worktree isolation, and simple enough that agents can automatically keep previews up to date for visual components.

## Solution

Forma will add a React-first component preview system built around explicit, colocated preview sidecars and an app-owned preview server contract. Projects opt in with a committed `forma.preview.ts` root config authored through a shared helper package. Visual components define colocated sidecars such as `Button.preview.tsx`, and the preview server dynamically scans those sidecars to build a standardized manifest.

Inside Forma, preview lives in the existing right-side panel as a dedicated mode. The user explicitly opens the preview panel, and once open, Forma automatically follows previewable component files changed in the current active turn, falling back to the latest completed turn when idle. Changed previewable components appear as tabs at the top of the panel, while an `All previews` picker gives users manual override. Forma embeds each selected preview case as a full page URL in an iframe, preserving the app's actual rendering environment.

Preview execution is thread/worktree-scoped. Forma manages one preview server per active thread/worktree, assigns its loopback port, waits for readiness by polling the manifest endpoint, keeps it warm for a short idle timeout, and exposes startup/render failures with retry controls. Preview sidecars require an explicit default case and support named cases, wrappers/providers, viewport metadata, and case selection. Users can pin a preview, override viewport, and keep working even when subsequent turns touch non-visual files.

## User Stories

1. As a design engineer, I want to preview an isolated `Button` instead of a whole page, so that I can fine-tune spacing, states, and interaction details without page noise.
2. As a frontend developer, I want Forma to show component previews inside the same workspace as the agent conversation, so that I do not need to switch tools constantly.
3. As a user working with an agent, I want the preview panel to follow the visual component the agent is actively changing, so that the preview stays relevant to the current work.
4. As a user, I want preview to ignore non-visual support files, so that editing utility files does not constantly disturb my visual review flow.
5. As a user, I want previously valid previews to remain visible when the current turn only changes non-previewable files, so that the panel remains useful during mixed implementation work.
6. As a user, I want changed previewable components to appear as tabs, so that I can quickly switch between several UI pieces touched in the same turn.
7. As a user, I want an `All previews` picker, so that I can manually inspect any component in the project even when it was not touched in the current turn.
8. As a user, I want to pin a component preview, so that auto-follow stops moving me away while I am fine-tuning one component.
9. As a user, I want Forma to remember my selected component, case, viewport, and pin state per thread, so that switching threads does not destroy my context.
10. As a design engineer, I want each component preview to open on a sensible default case, so that the first render is intentional rather than arbitrary.
11. As a component author, I want to define named cases such as `default`, `disabled`, `loading`, or `open`, so that the preview reflects real UI states instead of generic prop playground noise.
12. As a component author, I want per-case viewport metadata, so that mobile-first and desktop-first components can open in sensible sizes.
13. As a user, I want to override the viewport in the panel, so that I can inspect the same component across sizes without rewriting preview definitions.
14. As a project maintainer, I want preview setup to live in committed repo config, so that the behavior is reproducible across machines, branches, and worktrees.
15. As a team building many apps, I want a shared preview contract that works across projects, so that Forma preview is portable instead of custom per repo.
16. As a React app author, I want preview sidecars to be colocated with components, so that ownership and discovery remain obvious.
17. As a user of complex UI systems, I want previews to support app-wide and per-preview wrappers/providers, so that components that depend on theme, router, or query context can render correctly.
18. As a user, I want each preview rendered by the app's own environment, so that CSS, fonts, runtime behavior, and providers match reality.
19. As a user, I want Forma to manage preview server startup for me, so that the feature feels like Xcode-style live preview rather than another manual dev task.
20. As a user working in multiple threads or worktrees, I want each thread to get its own preview server context, so that one thread's edits do not contaminate another thread's preview.
21. As a user, I want preview readiness to be deterministic, so that the panel only switches after the preview server has rebuilt and the target preview is actually renderable.
22. As a user, I want clear error states when a case fails to render, so that I can diagnose broken preview definitions without losing my place in the panel.
23. As a user, I want clear startup failure details, including command and working directory, so that preview server problems are debuggable.
24. As a project maintainer, I want preview ids and labels to be deterministic by default, so that authors do not have to invent extra metadata for every component.
25. As an agent-assisted developer, I want agents to add preview sidecars for new visual components automatically, so that previews become part of normal delivery rather than an afterthought.
26. As a user, I want non-visual files to require no preview definitions, so that the system stays focused on visible UI work.
27. As a platform maintainer, I want the preview manifest to expose enough metadata for file-to-preview correlation, so that Forma can auto-follow changed components without editor integration.
28. As a product team, I want v1 to be React-first with extension points, so that the first release is useful quickly without blocking future adapters.

## Implementation Decisions

- The feature is React-first in v1, with an adapter boundary so the core model can expand later without redefining the user experience.
- Forma previews isolated components, not full application pages, because the primary job is tuning component-level UI.
- Preview definitions are explicit and colocated sidecars, not auto-detected from component files and not inline in production component modules for v1.
- Projects opt in through a committed root config file, `forma.preview.ts`, authored through a shared helper package to keep the contract portable across repos.
- Preview configuration is a first-class preview concept, not an overload of generic project scripts, because preview needs dedicated semantics for startup, readiness, manifest discovery, and lifecycle.
- The preview server is app-owned. Forma does not compile arbitrary project files directly.
- The preview server exposes a standardized HTTP contract. At minimum it serves a manifest endpoint and renderable preview case URLs under a reserved Forma namespace.
- Forma assigns the loopback port and passes it to the preview server through environment variables. The preview server is required to bind there.
- Manifest polling is the readiness check. Forma only treats preview as ready after the manifest responds successfully and decodes correctly.
- Manifest entries include preview ids, labels, component paths, preview sidecar paths, case lists, and default-case metadata.
- Preview ids are derived deterministically from paths. Labels default from file names or paths with optional override for friendlier presentation.
- Sidecars are discovered by dynamic scanning rather than a manually curated registry. The scan pattern should remain configurable through `forma.preview.ts` with a sensible default such as `**/*.preview.tsx`.
- Preview sidecars require a named default case. V1 uses named cases instead of generic Storybook-style prop controls.
- Preview cases may specify preferred viewport metadata. Users may override viewport in the panel, and the override persists per thread.
- Preview definitions support both global wrappers/providers from root config and per-preview wrappers/providers from sidecars.
- Forma embeds previews as full-page iframe URLs, not as directly injected component trees.
- The preview panel reuses the existing right-side panel model and runs as a single mutually exclusive panel mode alongside existing right-panel surfaces.
- Opening preview mode is explicit user intent. Once open, the internal preview selection can auto-follow changed previewable files.
- Auto-follow is driven by thread-local changed-file signals from agent activity, not by direct editor-focus integration.
- Changed previewable components in the current active turn are surfaced as top-level component tabs. When no turn is active, Forma falls back to the latest completed turn's changed previewable components.
- If a turn changes multiple previewable components, all of them are surfaced as tabs instead of collapsing to a single winner.
- Convention-based sidecar resolution is used for auto-follow. When a changed component file has a colocated preview sidecar, Forma resolves and switches to that preview.
- Auto-switching only occurs after a successful refresh. If the candidate preview is still rebuilding or fails, Forma keeps the previous valid preview visible.
- When the preview panel is open and the current turn only changes non-previewable files, Forma keeps showing the previous valid preview rather than clearing the panel.
- Preview servers are scoped one-per-thread/worktree and reused across preview selections within that thread.
- Preview server lifecycle is Forma-managed with a warm idle timeout to balance responsiveness and resource control.
- Server startup and runtime failures are surfaced in-place with retry controls and launch-context details rather than collapsing the panel or silently failing.
- All previews remain visible in the global picker. V1 does not add hidden/private preview filtering.
- Agents are expected to create or update visual component sidecars as part of normal feature work.

## Testing Decisions

- A good test should verify observable behavior and contract stability, not implementation details such as internal hooks, timers, or incidental state shape.
- The shared preview config and manifest schema should have contract tests that validate config decoding, manifest structure, deterministic id generation, label resolution, case metadata, and wrapper metadata handling.
- The preview-discovery layer should have tests for dynamic sidecar scanning, configurable glob behavior, deterministic path-based id derivation, and changed-file-to-preview resolution.
- The preview runtime manager should have tests for thread/worktree process scoping, loopback port assignment, readiness polling, warm idle timeout behavior, retry handling, and failure propagation.
- The preview selection model should have tests for auto-follow behavior, pin behavior, changed-component tab derivation, current-turn versus latest-completed-turn fallback, and persistence of per-thread preview state.
- The panel UI should have browser-style interaction tests covering explicit open/close behavior, tab switching, case switching, viewport override, startup loading states, case-level error states, and recovery flows.
- The iframe/render URL contract should have end-to-end style tests proving that the selected preview id and case produce the correct navigable URL and only switch after successful refresh.
- Prior art should be drawn from the repo's existing patterns for browser interaction tests, route/panel state tests, server-side service lifecycle tests, schema/contract tests, and thread-scoped runtime behavior tests.

## Out of Scope

- Framework-agnostic support in v1 beyond a future adapter boundary.
- Rendering full application pages as the main preview model.
- Direct component injection into Forma without an iframe.
- Auto-detecting preview definitions from component files as the source of truth.
- Generic prop editors, args tables, or Storybook-style control surfaces in v1.
- Inline preview definitions at the bottom of component files in v1.
- Editor-focus integration that follows the user's currently open file in Cursor, VS Code, or another IDE.
- Simultaneously showing preview and other right-panel modes side by side.
- Hidden/private preview filtering in the global picker.
- Non-visual files requiring preview artifacts.

## Further Notes

- The product goal is a design-engineering workflow: users should be able to ask an agent to build a visual component and immediately inspect that component in isolation inside Forma.
- The feature should feel Xcode-like in startup behavior, but the rendering responsibility stays with the app project's own preview server.
- The PRD assumes a standardized shared package and config contract that can be reused across many projects integrating with Forma.
- The PRD assumes local-only documentation workflow for now, with PRDs stored in a root `PRDs/` folder ignored by git for later reference and planning.
