---
"effect": patch
---

Add `Flag.withHidden` (and `Param.withHidden`) to hide flags from `--help` output and shell completions while keeping them fully parseable on the command line.

Useful for experimental, internal, or deprecated flags that should be accepted but not advertised, e.g. `--experimental-foo`, debug toggles, or escape hatches that are not yet committed to the public CLI surface.

```ts
import { Flag } from "effect/unstable/cli"

const experimental = Flag.boolean("experimental-foo").pipe(
  Flag.withHidden
)
```
