# Browser Phase 0 Spikes

These spikes validate the architectural decisions recorded beside this file. They exercise Electron 41 against real browser surfaces rather than mocking browser lifecycle or CDP behavior.

## Environment Used for Recorded Results

- macOS 26.5.1, arm64
- Apple M4 Max, 64 GiB RAM
- Electron 41.5.0
- installed Playwright 1.60.0
- Node.js 25.8.2 orchestration process

Results are documented in `findings.md`. Generated frames, videos, screenshots, logs, and transient JSON files under `results/` are intentionally ignored.

## Commands

```bash
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs automation
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs view-automation
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs hidden
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs offscreen-recording
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs covered-recording
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs media-recorder
node .plans/browser-phase-0/spikes/run-electron-spikes.mjs latency
node .plans/browser-phase-0/spikes/run-gateway-spike.mjs
```

The Electron harness uses the repository's installed Electron and Playwright packages. The gateway harness uses the locked `ws` package already present in the pnpm installation.

## Scope

These are architectural probes, not production modules. They deliberately avoid changing application behavior. Production work must reimplement the selected patterns with typed contracts, Effect services, cancellation, security policy, tests, and resource cleanup.

