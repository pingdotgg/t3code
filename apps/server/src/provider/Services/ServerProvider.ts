import type { ServerProvider } from "@harness/contracts";
import type { Effect, Stream } from "effect";

export interface ServerProviderShape {
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
