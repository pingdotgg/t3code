---
"@effect/platform-node-shared": patch
---

Pass Node's `windowsHide` flag for spawned Windows children by default (except detached processes), with an independent
`windowsHide` option for callers that need visible GUI windows. Process-group cleanup now invokes `taskkill` without a
`cmd.exe` wrapper and hides its window.
