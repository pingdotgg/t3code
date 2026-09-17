---
"effect": patch
---

ManagedRuntime: add `Symbol.asyncDispose`, enabling `await using` syntax

```ts
import { Effect, Layer, ManagedRuntime } from "effect"

await using runtime = ManagedRuntime.make(Layer.empty)

await runtime.runPromise(Effect.log("Hello, world!"))
// runtime is disposed automatically at the end of the scope
```
