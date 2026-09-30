---
"effect": patch
---

Add a scoped `CliConfig` service for customizing the built-in global flags used by CLI command runners.

For example, provide an explicit list that omits `GlobalFlag.LogLevel` to remove the built-in `--log-level` flag:

```ts
import { Effect } from "effect"
import { CliConfig, Command, GlobalFlag } from "effect/unstable/cli"

const program = Command.run(command, { version: "1.0.0" }).pipe(
  Effect.provide(
    CliConfig.layer({
      builtIns: [
        GlobalFlag.Help,
        GlobalFlag.Version,
        GlobalFlag.Completions
      ]
    })
  )
)
```
