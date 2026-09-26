---
"@effect/platform-browser": patch
---

Invoke custom `BrowserRuntime.runMain` teardown callbacks when the main effect completes, and remove the `pagehide` listener once the main fiber finishes.
