# Browser Phase 0.5

Phase 0.5 closes the production-risk questions raised after the original browser spikes. It does not add application behavior. It expands the executable harness and revises the architecture decisions before session implementation begins.

## Commands

```bash
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs renderer-reload
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs injected-runtime
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs recording-endurance
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs input-origin
node .plans/browser-phase-0/spikes/run-tunnel-security-spike.mjs
```

## Decisions

- `006-renderer-failure-boundary.md`: keep `<webview>` for this iteration, but describe it as route-durable rather than process-durable and specify session-loss behavior.
- `007-playwright-injected-runtime.md`: use Playwright's injected runtime as the initial semantic locator/actionability substrate, behind a T3-owned adapter and compatibility tests.
- `008-recording-endurance.md`: retain covered parking provisionally, with a one-recording default and further soak/platform tests required before widening concurrency.
- `009-loopback-threat-model.md`: a plain loopback listener is not an authorization boundary; stable origins and a browser-enforced capability authority are required.
- `010-human-input-interruption.md`: Electron `before-input-event` did not observe CDP keyboard dispatch in the tested guest, so human interruption can start with native input observation without a dispatch suppression window, while retaining regression coverage.

See `findings.md` for measured results and the resulting roadmap changes.
