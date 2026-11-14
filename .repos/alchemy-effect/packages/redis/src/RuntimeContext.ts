import type * as Context from "effect/Context";

/**
 * Structural twin of `alchemy/RuntimeContext`'s service identifier, so this
 * package colors its client as runtime-only without depending on `alchemy`.
 *
 * Only the identifier matters (`"RuntimeContext"`); the service shape is left
 * opaque because the client never reads it. It must stay mutually assignable
 * with the real one so a host providing `RuntimeContext` satisfies it.
 */
export interface RuntimeContext extends Context.ServiceClass.Shape<"RuntimeContext", any> {}
