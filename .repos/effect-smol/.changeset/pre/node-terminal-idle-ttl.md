---
"@effect/platform-node-shared": patch
---

Keep NodeTerminal's readline interface alive briefly between adjacent prompts to avoid a Windows TTY raw-mode hang.
