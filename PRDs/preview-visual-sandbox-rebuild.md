# Preview Visual Sandbox Rebuild PRD

## Problem Statement

Forma's current preview experience feels primitive and overly manual because it is tied to thread activity and project-specific setup rather than the actual frontend refinement loop. A developer may be working on a visual detail such as spacing, animation, typography, or component styling, but the current system tries to infer preview targets from thread-scoped changed files and thread history. That is not a trustworthy source of truth for what the developer actually wants to see.

The current model also relies on repo mutation and framework-specific assumptions. It expects project-local setup, treats the preview runtime as thread-scoped, and makes the user work through an MVP flow instead of a natural frontend workflow. This is especially limiting for users working across multiple projects and frameworks, and it undermines a key product differentiator: isolated frontend iteration without starting the full project dev server.

From the user's perspective, the desired workflow is much simpler: pick the component or file they want to refine, open it in Forma's editing surface, save changes, and see the preview update live in a high-fidelity isolated sandbox. The preview feature should work like magic by default, require no project changes in the happy path, remain stable across chat threads, and eventually support multiple frameworks through adapters.

## Solution

Rebuild Preview as a manual-target, adapter-based visual sandbox system.

The new Preview experience will stop being thread-driven. Instead of inferring the active preview from chat activity, the user will explicitly choose the file they want to preview, and choose the export when a file has multiple previewable exports. Preview will remain in the current bottom-drawer location with a left picker and right preview canvas. Selecting a target will automatically open a new Preview Edit mode in the existing diff-panel location, reusing Forma's in-app Monaco file editor implementation.

Preview runtimes will be keyed by a resolved app target rather than by thread. A resolved app target includes the environment, project, optional worktree, resolved app root, adapter, and shell/context profile. Forma will warm this runtime in the background when the user is active in that app target, so opening preview feels fast.

The core system will be adapter-based, with first-party React/Next support first and a public extension model for future adapters. The user-facing feature remains called Preview, while the internal runtime is a harness-owned visual sandbox that compiles and renders only the minimum correct component dependency subgraph. The happy path requires no project changes. Forma will auto-detect likely app targets and frameworks, and only show a lightweight onboarding flow when detection is ambiguous or sandbox boot fails.

The first release will optimize for frontend visual refinement only. It will focus on isolated visual rendering of components and files, high-fidelity styling support, manual target selection, save-triggered live refresh, recoverable preview failures, and optional escape hatches. It will explicitly not try to provide full server, data, routing, or app-runtime fidelity in v1.

## User Stories

1. As a frontend developer, I want to manually choose the file I want to preview, so that the preview matches my actual visual focus instead of inferred thread activity.
2. As a frontend developer, I want Preview to stay locked to the target I selected, so that it does not unexpectedly switch while I am working.
3. As a frontend developer, I want to choose a specific export when a file contains multiple components, so that I can refine the exact visual surface I care about.
4. As a frontend developer, I want the file picker to support search, so that I can jump to known components quickly.
5. As a frontend developer, I want the file picker to support browsing, so that I can discover components even when I do not know their names.
6. As a frontend developer, I want previewable items to be ranked by visual likelihood, so that the picker surfaces useful frontend targets first.
7. As a frontend developer, I want selecting a preview target to automatically open the file in Forma's in-app editor, so that I can immediately start editing.
8. As a frontend developer, I want the in-app editor to appear in the same location as the current diff editor, so that preview editing fits the existing layout model.
9. As a frontend developer, I want the diff panel to preserve my prior diff context when Preview Edit mode opens, so that I can switch back without losing my place.
10. As a frontend developer, I want the preview drawer to keep its current structure of left picker and right canvas, so that the new experience feels familiar while becoming more capable.
11. As a frontend developer, I want saved edits to refresh the selected preview live, so that I can iterate quickly on styling and motion.
12. As a frontend developer, I want Preview to rebuild only the minimum correct component dependency subgraph, so that visual iteration stays fast and does not require compiling the whole app.
13. As a frontend developer, I want Preview to avoid starting the full project dev server in the happy path, so that Forma remains meaningfully faster and more focused than whole-app tools.
14. As a frontend developer, I want preview failures to stay recoverable after a save, so that I can keep editing and fix the issue without losing my work.
15. As a frontend developer, I want Preview to show clear warmup phases, so that I understand whether Forma is detecting an app, resolving an adapter, building the sandbox, or indexing targets.
16. As a frontend developer, I want Preview to work by default without adding files to my repo, so that the feature feels magical instead of configuration-heavy.
17. As a frontend developer working in a monorepo, I want Forma to auto-detect the likely app target, so that Preview works with minimal friction.
18. As a frontend developer working in an ambiguous repo, I want a lightweight onboarding flow only when necessary, so that I can help Forma choose the right app root, adapter, or shell without mutating the project.
19. As a frontend developer, I want Forma to remember my resolved app target choices per project, so that I do not repeat onboarding decisions.
20. As a React or Next developer, I want Preview to render common visual components in an isolated sandbox, so that I can refine client-side styling and interactions without full app runtime overhead.
21. As a React or Next developer, I want Tailwind, CSS Modules, PostCSS, Sass, and global CSS to work well in Preview, so that the rendered result matches the actual styling stack used in my app.
22. As a frontend developer, I want best-effort provider and environment shims, so that components render visually when possible even if app context is incomplete.
23. As a frontend developer, I want Preview to warn me clearly when a component is only partially faithful in isolated mode, so that I do not mistake a degraded render for real app behavior.
24. As a frontend developer, I want optional repo-side escape hatches, so that I can improve fidelity for difficult apps without making configuration mandatory.
25. As a frontend developer, I want an optional app-level preview config to override app root, adapter choice, wrappers, providers, and runtime hints, so that complex apps can still achieve good sandbox fidelity.
26. As a frontend developer, I want optional per-component preview files to define scenarios, controls, wrappers, mocks, and preferred export behavior, so that I can refine hard cases precisely when automatic inference is insufficient.
27. As a design-system maintainer, I want manual file selection and export switching to work well across reusable components, so that Preview supports deliberate UI refinement rather than guessing.
28. As a developer moving between chat threads, I want Preview state to remain stable because it is tied to the app target rather than the thread, so that the preview tool behaves like a workspace capability instead of a chat accessory.
29. As a developer using multiple projects, I want Preview preferences to persist per resolved app target, so that each project can remember its own target, shell, and viewport behavior.
30. As a developer, I want global user defaults such as auto-opening Preview Edit mode to persist across projects, so that the tool adapts to my workflow.
31. As a developer new to Forma, I want Preview to feel fast and obvious on first use, so that it becomes a trustworthy frontend tool rather than an experimental feature.
32. As an open-source contributor, I want Preview to be built on an adapter contract, so that additional framework adapters can be added later without rewriting the core runtime.
33. As an open-source adapter author, I want a stable adapter interface, so that I can add support for another frontend stack without coupling to thread-specific UI behavior.
34. As a team maintaining Forma, I want the new Preview architecture to separate deep modules cleanly, so that runtime behavior, detection, picker logic, and editing workflows can be tested in isolation.
35. As a future Vue or other framework user, I want the Preview system to be designed for adapter expansion from the start, so that framework support can grow without redesigning the product.
36. As a frontend developer, I want Preview to default to isolated visual refinement and not full app fidelity, so that the tool remains focused on design iteration rather than app-runtime emulation.
37. As a frontend developer, I want Preview to remain useful even when I am not using an agent-driven thread workflow, so that it stands on its own as a development surface.
38. As a frontend developer, I want Preview to feel like a core workspace capability instead of an afterthought bolted onto chat, so that it supports real production iteration.
39. As a developer who occasionally needs external tooling, I want external IDE opening to remain available as a secondary action, so that the in-app editor does not remove existing escape hatches.
40. As a maintainer of the current preview feature, I want the rebuilt system to reuse the strongest existing primitives where possible, so that the rewrite improves the product without discarding valuable infrastructure.

## Implementation Decisions

- Preview remains the user-facing name of the feature.
- The internal architecture should treat the rendering engine as a visual sandbox rather than a thread-scoped preview session.
- The primary workflow is manual-target selection, not thread-derived target inference.
- The preview runtime identity is a resolved app target, not a thread.
- A resolved app target includes the environment, project, optional worktree, resolved app root, adapter, and shell/context profile.
- Preview should warm its runtime in the background when the user is active in a resolved app target, rather than waiting for drawer open.
- The current preview drawer structure should remain conceptually intact: left picker, right preview canvas.
- Selecting a preview target should be treated as navigation into Preview Edit mode, not a purely local UI state change.
- Preview Edit mode should live in the existing diff-panel location and reuse the current in-app Monaco file editor implementation.
- When Preview Edit mode opens, existing diff context should be preserved so the user can switch back.
- The editor remains file-based; export switching changes the preview target but does not create separate editor identities.
- The manual picker should be both searchable and browsable.
- The picker should only show previewable items, while ranking visually likely items higher.
- For multi-export files, the default behavior should auto-pick the best export and offer a lightweight export switcher.
- The happy path should not require repo changes, preview setup files, project wiring, or project mutation.
- When auto-detection is ambiguous or sandbox boot fails, Forma should use a fallback onboarding flow.
- The fallback onboarding flow should progressively collect app root, adapter, and shell/context only when needed.
- The adapter model should be part of the core architecture from the start.
- First-party React/Next support ships first; other framework adapters come later.
- The extension model should support future community adapters because the project is open source.
- The first React/Next adapter should optimize for isolated visual frontend surfaces, not for full app-runtime fidelity.
- The first React/Next adapter should support plain CSS, CSS Modules, Tailwind/PostCSS, Sass, and global CSS as first-class styling systems.
- CSS-in-JS support is best-effort in the first release.
- The sandbox should use best-effort provider and environment shims, but should not fabricate false confidence when fidelity is poor.
- The system should prefer targeted module updates or HMR-style refresh when possible, with safe rerender fallback.
- Save-triggered live updates are required; unsaved-buffer live editing is not required in v1.
- Preview failures after save should be recoverable and non-blocking.
- Optional repo-side escape hatches remain available but must never be required.
- The optional app-level escape hatch can override app root, adapter, shell, wrappers, providers, and runtime hints.
- The optional per-component escape hatch can override discovery behavior, preferred export, cases, controls, wrappers, and preview-only mocks for a component.
- Preview state should no longer be owned by the active thread.
- Preview should persist a per-app-target state layer plus a small global defaults layer.
- Core deep modules should include app target resolution, target cataloging, adapter integration, visual sandbox runtime management, preview state management, and escape-hatch loading.
- Contracts and state models should be revised to remove thread-keyed preview identity and replace it with resolved-app-target identity plus richer progress and status events.

## Testing Decisions

- A good test should verify externally observable behavior rather than implementation details.
- Runtime tests should assert lifecycle, state transitions, and output/error behavior through stable interfaces rather than internal caching or scheduling mechanics.
- UI tests should assert user-visible workflows such as selection, navigation, save behavior, warmup states, and error recovery rather than component internals.
- Parser and resolver tests should focus on deterministic inputs and outputs, confidence decisions, and fallback behavior.
- The app target resolver should be tested thoroughly because its confidence model and onboarding fallback are central to zero-setup behavior.
- The preview target catalog should be tested thoroughly because manual target selection is now the core user entrypoint.
- The visual sandbox runtime should be tested thoroughly because it owns the differentiating behavior of isolated subgraph rebuilds, warmup phases, and recoverable failures.
- The React/Next adapter should be tested thoroughly because it is the first framework-specific implementation and sets the adapter contract precedent.
- The escape hatch loader should be tested thoroughly because optional overrides must compose cleanly with automatic inference.
- The Preview Edit mode integration should be tested for mode switching, editor opening, save-triggered preview refresh, and preservation of prior diff context.
- Prior art should come from the existing mix of store tests, preview support and setup tests, preview catalog logic tests, diff editor/browser tests, and route-level UI integration tests already present in the codebase.
- Similar testing patterns already exist for persistent UI state, preview-related utility logic, Monaco-based diff editing flows, and browser-level interaction coverage, and those patterns should be reused where they still match the new product surface.

## Out of Scope

- Full server, data, router, auth, or request-context fidelity in v1.
- Full Next server-component semantics in isolated preview.
- Non-React adapters in the first release.
- Unsaved-buffer live editing in the first release.
- Automatic thread-driven preview targeting in the new system.
- Requiring users to add configuration or preview files to their projects.
- Automatically mutating project files to set up Preview.
- Whole-project app compilation or mandatory full dev server startup in the happy path.
- Treating route-backed preview as a first-class primary workflow in v1.

## Further Notes

- The rebuilt system should preserve the strongest existing primitives where they still fit the new product shape, especially existing editor infrastructure, preview tree/picker ideas, and reusable cataloging logic.
- The biggest conceptual shift is that Preview should become a workspace/frontend tool rather than a chat-thread tool.
- The most important product story for the first release is: a developer picks a component file, Forma opens it in the in-app editor, every save updates a high-fidelity isolated preview instantly, and none of this requires starting the full project dev server.
- The architectural bar for success is not just better UI polish. The new system should feel fundamentally more trustworthy because target selection is explicit, runtime identity is stable, and fallback configuration is optional rather than mandatory.
