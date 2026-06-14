# ADR 007: Playwright Injected Runtime

## Status

Accepted as the initial implementation direction; supersedes the bespoke interpretation of ADR 002.

## Decision

Load a version-pinned Playwright injected runtime into each guest frame through the persistent CDP connection. Use it for selector parsing, role/name/text/test-id resolution, shadow DOM traversal, element-state checks, hit-target checks, and locator re-resolution.

T3 continues to own:

- browser sessions, hosts, tabs, command queues, authorization, and cancellation;
- CDP target discovery and per-frame execution contexts;
- native input dispatch, navigation, dialogs, downloads, artifacts, and remote reachability;
- the stable T3 automation contract exposed to agents.

Do not expose Playwright internal objects directly as the product API.

## Evidence

The `injected-runtime` spike extracted the runtime bundled with installed Playwright 1.60.0 and evaluated it inside the real Electron guest over CDP:

- injected source size: `307,101` bytes;
- install time: approximately `6.5–8.5 ms` across the recorded runs;
- role/name locator matched the button;
- role/name locator pierced an open shadow root;
- the same locator re-resolved after the input element was replaced;
- same-origin frames still require a separate injected runtime and routing context.

## Constraints

- Playwright's injected runtime is internal and version-coupled. Pin its version and run compatibility fixtures on upgrades.
- OOPIFs remain separate CDP targets. The Browser Control Service must enable target auto-attach and maintain frame-to-session routing.
- Locators are durable query descriptions resolved at action time. Snapshot node references are optional, short-lived accelerators only.
- The T3 adapter must compare key behavior against real Playwright tests for actionability, shadow DOM, frames, rerenders, and strictness.

## Fallback

If a future Playwright release makes the injected runtime impractical to consume, retain the T3 contract and replace only the internal locator provider. Do not leak the vendored runtime across architecture boundaries.
