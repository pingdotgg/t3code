---
"effect": patch
---

Add execution-plan lifecycle events via an optional `onEvent` handler on `Effect.withExecutionPlan` and `Stream.withExecutionPlan`.

The handler receives an `ExecutionPlan.Event`, a tagged union of `AttemptStart`, `AttemptSuccess`, and `AttemptFailure`, allowing attempt outcomes to be observed from outside the effect for logging and metrics:

```ts
import { Effect } from "effect"

Effect.withExecutionPlan(program, plan, {
  onEvent: (event) => Effect.log("execution plan event", event)
})
```

Every `AttemptStart` is followed by exactly one terminal event. `AttemptFailure` carries the full failure `Cause`, so defects and interruption are reported as well as expected errors, and terminal events run like finalizers so they are emitted even when the attempt is interrupted. Event numbering matches `ExecutionPlan.CurrentMetadata`: `attempt` is cumulative across steps, while `stepAttempt` is 1-based within the current step.
