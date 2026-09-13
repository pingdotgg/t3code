---
"effect": patch
---

Fix consolePretty ignoring explicit colors option in non-TTY environments.

When colors is explicitly set to true, prettyLoggerTty was still gating it with processStdoutIsTTY check, making it impossible to enable colors in non-TTY environments like Vite dev server.
