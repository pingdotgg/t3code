---
"effect": patch
---

Record: make `fromIterableBy` dual, allowing data-last usage in `pipe`

```ts
import { pipe, Record } from "effect"

const users = [
  { id: "2", name: "name2" },
  { id: "1", name: "name1" }
]

pipe(users, Record.fromIterableBy((user) => user.id))
```
