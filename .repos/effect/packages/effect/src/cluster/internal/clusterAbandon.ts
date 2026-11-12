import type * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import { Abandon } from "../ClusterSchema.ts"

// Annotate before opening the interruptible region. An interrupt already
// pending on an uninterruptible fiber fires as soon as the region opens, and
// the annotation is merged into that pending cause instead of being lost.
export const interrupt: Effect.Effect<never> = Effect.withFiber((fiber) => {
  fiber.interruptUnsafe(fiber.id, Abandon.annotation)
  return Effect.interruptible(Effect.never)
})

export const isCause = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => reason._tag === "Interrupt" && reason.annotations.has(Abandon.key))
