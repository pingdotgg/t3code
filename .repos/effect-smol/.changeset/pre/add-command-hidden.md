---
"effect": patch
---

Add `Command.withHidden` to hide subcommands from `--help` output, shell completions, and "did you mean?" suggestions, while keeping them fully invocable by exact name.

Useful for experimental or internal subcommands that should be accepted but not advertised on the public CLI surface.

```ts
import { Command } from "effect/unstable/cli"

const experimental = Command.make("experimental").pipe(
  Command.withHidden
)

const root = Command.make("mycli").pipe(
  Command.withSubcommands([experimental])
)
```
