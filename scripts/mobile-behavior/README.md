# Mobile behavior

`vp run mobile:behavior` checks what the iOS app does, from its own state rather than pixels: scroll position, dropped frames, composer drafts and focus, status labels, and which thread opens. It leases an iPhone 18 Pro and an iPad Pro 13 from the Simlock pool and runs the cases on both in parallel. It is the companion to `vp run mobile:e2e`, which checks layout.

No model runs. Each device gets its own server whose only provider, `evalbot`, is an Fx instance backed by [`fake-fx.ts`](fake-fx.ts). A `[[eval:…]]` marker in a message picks its scripted reply: a paced stream, a held turn, a question, two subagents, or a failure. Each device also gets its own Metro with the dev-only probe ([`behavior-probe.ts`](../../apps/mobile/src/features/development/behavior-probe.ts)) compiled in. The probe reads app state through Metro's Hermes inspector, and agent-device drives the touches.

## Run

Needs `SIMLOCK_AGENT_DEVICE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`, like `mobile:e2e`.

```sh
vp run mobile:behavior                                    # both devices, 3 samples per case
vp run mobile:behavior --device iphone-18-pro --samples 1 --case scroll-up-never-teleports
vp run mobile:behavior --list                             # devices and cases
```

Output lands in `artifacts/mobile-behavior/<run>/`: `summary.md` is the scoreboard. Each device's folder holds `results.jsonl` (one row per case sample), `run.log`, `metro.log`, and the server under `env/`. A full run takes about 15 minutes.

A case fails when half or more of its graded samples fail, and is `incomplete` when errors outnumber graded samples. The run fails on a `guard` or `control` case that fails or is incomplete. `bad` cases reproduce known bugs and fail until those are fixed.

## Metrics

- **Scroll.** The probe reads the thread list's state on every JS frame and records each visible row's y on screen. `backwardPx` is the largest move against the drag. `teleports` counts one-frame moves over 400 pt, faster than a real fling. `maxFromEndPx` is the distance from the latest message.
- **Jank.** JS-thread frames from `requestAnimationFrame` in the probe, UI-thread frames from a worklet loop. Simulators render at 60 Hz, and injected swipes load the simulator's UI thread, so swipe cases grade JS frames only.
- **Composer.** The draft store, the editor's text from the accessibility tree, whether it expanded, and whether the keyboard is up.
- **Status.** Each Home row's status from the app's own `resolveThreadListV2Status`, and the Working shelf count, against server state.

## Add a case

Cases are data in [`cases.ts`](cases.ts): an `id`, a `kind` (`bad` fails on `main` today, `guard` must keep passing, `control` is ordinary use), its `source` issue, the `scenario` that produces its metrics, a `key` metric, and `checks`. A new flow goes in [`scenarios.ts`](scenarios.ts). Add a case before its fix, so it fails on `main` while the bug exists; flip it from `bad` to `guard` when the fix lands.

Not covered: Live Activities and notification taps (they need a T3 Connect relay and delivered pushes), native editor scroll, the background-work pill and async questions (Fx has no background tasks), and 120 Hz pacing.
