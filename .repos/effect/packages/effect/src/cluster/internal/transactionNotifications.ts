import * as Context from "../../Context.ts"
import type * as Effect from "../../Effect.ts"
import type { MalformedMessage, PersistenceError } from "../ClusterError.ts"

export const TransactionNotifications = Context.Reference<
  Array<Effect.Effect<void, PersistenceError | MalformedMessage>> | undefined
>("effect/cluster/MessageStorage/TransactionNotifications", { defaultValue: () => undefined })
