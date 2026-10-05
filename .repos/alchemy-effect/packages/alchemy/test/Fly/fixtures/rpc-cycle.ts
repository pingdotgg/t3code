import * as Fly from "@/Fly";
import type * as Effect from "effect/Effect";

export interface Named {
  name: () => Effect.Effect<string>;
}

/**
 * Two public Services that bind each other. Each is declared as a tag class
 * with its method shape, so the other can bind it before its implementation
 * exists. `rpc-ping.ts` and `rpc-pong.ts` implement them; deploying the pair
 * needs the Service precreate to break the dependency cycle.
 */
export class Ping extends Fly.Service<Ping, Named>()("Ping") {}
export class Pong extends Fly.Service<Pong, Named>()("Pong") {}
