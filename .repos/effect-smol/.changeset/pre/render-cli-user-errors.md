---
"effect": patch
---

Add an optional user-facing message to CLI `UserError` values with safe cause-based fallbacks. `Command.run` and `Command.runWith` now render handler `UserError` failures through the installed output formatter; hosts that already print these errors should remove their duplicate output. Set `renderErrors: false` when the host should own error rendering.
