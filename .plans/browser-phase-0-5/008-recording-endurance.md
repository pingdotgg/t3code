# ADR 008: Covered Recording Is Provisional

## Status

Accepted with concurrency and platform gates.

## Decision

Keep CDP screencast plus Chromium MediaRecorder and the covered full-size parking surface for the first recording implementation.

Default to one actively recorded tab per desktop window until multi-tab budgets are measured. Hidden idle tabs remain offscreen; hidden recording tabs remain composited and covered.

## Evidence

The `recording-endurance` spike recorded a `1600×1200` covered webview for ten seconds at a requested 12 fps:

- 111–112 sampled frames, approximately 11.1–11.2 fps across the recorded runs;
- 9.98-second seekable H.264 MP4;
- main-process CPU sample approximately 3.5–3.8%;
- observed renderer working sets approximately 146 MiB and 99 MiB, plus GPU working set approximately 149 MiB.

This is stronger than the original 800×600 proof, but it is not a production concurrency budget.

## Required Before Raising Concurrency

- 30-minute soak with active timers, animation, HMR, and navigation;
- two and four simultaneous recording tabs;
- Retina device-scale-factor coverage;
- window resize, minimization, macOS Spaces, sleep/wake, and display changes;
- explicit `backgroundThrottling` policy and regression tests;
- proof that the cover cannot receive or leak pointer input to the parked guest;
- bounded frame queues with drop metrics and encoder-failure finalization.
