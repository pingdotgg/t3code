---
"effect": patch
---

Make CLI global settings directly yieldable and simplify built-in names.

`GlobalFlag.setting` now takes `{ flag, defaultValue }` and returns a setting that is a `Context.Reference`, so handlers and `Command.provide*` effects can `yield*` global setting values directly.

Built-in settings keep internal behavior in `runWith` (for example, `--log-level` still configures `References.MinimumLogLevel`) while also being readable as values.

Also renamed built-in globals:

- `GlobalFlag.CompletionsFlag` -> `GlobalFlag.Completions`
- `GlobalFlag.LogLevelFlag` -> `GlobalFlag.LogLevel`
