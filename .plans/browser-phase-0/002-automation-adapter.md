# ADR 002: Browser-Client-Style Semantic CDP Adapter

## Status

Superseded in implementation detail by `.plans/browser-phase-0-5/007-playwright-injected-runtime.md`.

## Decision

Build the primary automation adapter over a persistent Electron debugger connection using CDP accessibility, DOM, runtime, page, network, and input domains.

The adapter should offer Playwright-like concepts—role/name locators, text locators, frames, auto-waiting, stale references, dialogs, downloads, and actionability checks—but it must not depend on Playwright owning the browser or recognizing the guest as a `Page`.

Use two layers:

1. main-process CDP session and command/event transport
2. the version-pinned Playwright injected runtime behind a T3-owned compatibility adapter

Locator descriptions re-resolve at action time. Snapshot-scoped backend-node references are optional and ephemeral.

## Playwright Role

Use Playwright as:

- a behavior reference
- a test oracle against standalone test pages
- the initial injected selector/actionability runtime
- an optional adapter for future environment-hosted Chromium sessions

Do not expose a production Electron remote-debugging port merely to attach Playwright.

## agent-browser Role

agent-browser may be supported through a compatible CLI or command adapter backed by the same Browser Control Service. It must not launch an unrelated browser for collaborative preview sessions.
