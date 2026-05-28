import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface AgentAwarenessRelayShape {
  readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  AgentAwarenessRelayShape
>()("t3/relay/Services/AgentAwarenessRelay") {}
