---
"@effect/platform-node-shared": patch
---

Fix child process termination to escalate to `SIGKILL` when the initial signal does not stop the process within `forceKillAfter`.
