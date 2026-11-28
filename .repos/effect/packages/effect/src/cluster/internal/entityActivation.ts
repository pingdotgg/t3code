import * as Context from "../../Context.ts"
import type * as Latch from "../../Latch.ts"
import type * as Scope from "../../Scope.ts"

/** The entity lifetime, shared by all handler rebuilds within an activation. @internal */
export class CurrentActivationScope extends Context.Service<CurrentActivationScope, Scope.Scope>()(
  "effect/cluster/internal/CurrentActivationScope"
) {}

/** Opens when the activation retires and stops accepting new requests. @internal */
export class CurrentRetirementLatch extends Context.Service<CurrentRetirementLatch, Latch.Latch>()(
  "effect/cluster/internal/CurrentRetirementLatch"
) {}
