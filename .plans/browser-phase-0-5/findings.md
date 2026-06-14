# Phase 0.5 Findings

## Executive Decisions

1. The selected `<webview>` is route-durable, not process-durable. Renderer reload destroys its guest and state; `WebContentsView` survives that specific failure boundary.
2. Use Playwright's injected runtime behind the T3 Browser Control Service instead of implementing locator and actionability semantics from scratch.
3. Use locator descriptions that re-resolve at action time. Treat snapshot element references as ephemeral.
4. Covered recording remains viable at 1600×1200 for one tab, but concurrency and long-duration operation remain gated.
5. A loopback port is not an authorization capability. Stable origin, browser attribution, and bounded tunnel multiplexing are required before remote preview ships.
6. CDP keyboard dispatch did not trigger Electron `before-input-event` in the tested guest. Start with native input interruption and no timing suppression hack.

## Roadmap Changes

- Add host loss, window identity, session-loss UX, annotation preservation, port discovery, and guest hardening to the session foundation phase.
- Put persistent CDP, Playwright injected-runtime integration, console buffers, and network buffers in the automation phase.
- Add OOPIF target routing and per-frame injected runtimes to the automation acceptance criteria.
- Move remote preview behind a second browser-attribution spike; raw TCP transport feasibility alone is insufficient.
- Keep one active recording per window as the initial policy.
- Remove `shared` controller mode until concurrency semantics exist.

## Remaining Open Questions

- Browser-attributed local tunnel ingress that preserves application origin behavior.
- Multi-tab recording budgets and 30-minute platform soak results.
- Pointer/touch interruption behavior across macOS, Windows, and Linux.
- Recovery fidelity after renderer/window loss.
- Web-app viewing UX for separately hosted environment Chromium sessions.
