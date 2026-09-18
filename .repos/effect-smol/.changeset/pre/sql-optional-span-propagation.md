---
"effect": patch
---

Add `Statement.SpanPropagationEnabled` to scope driver span parenting under `sql.execute` for any SQL client. Disabled by default.

```ts
import { Effect } from "effect"
import { Statement } from "effect/unstable/sql"

query.pipe(Effect.provideService(Statement.SpanPropagationEnabled, true))
```
