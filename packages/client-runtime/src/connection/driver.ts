import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  PreparedConnection,
} from "./model.ts";
import { ConnectionResolver } from "./resolver.ts";
import { RpcSessionFactory, type RpcSession } from "../rpc/session.ts";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession;
}

export interface ConnectionDriverService {
  readonly connect: (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
}

export class ConnectionDriver extends Context.Service<ConnectionDriver, ConnectionDriverService>()(
  "@t3tools/client-runtime/connection/driver/ConnectionDriver",
) {}

export const connectionDriverLayer = Layer.effect(
  ConnectionDriver,
  Effect.gen(function* () {
    const resolver = yield* ConnectionResolver;
    const sessions = yield* RpcSessionFactory;

    const connect = Effect.fn("ConnectionDriver.connect")(function* (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) {
      const target = entry.target;
      yield* Effect.annotateCurrentSpan({
        "connection.environment.id": target.environmentId,
        "connection.target.kind": target._tag,
      });
      yield* reportProgress({ stage: "preparing" });
      const prepared = yield* resolver.prepare(entry);
      yield* reportProgress({ stage: "opening", prepared });
      const session = yield* sessions.connect(prepared);
      yield* reportProgress({ stage: "synchronizing", prepared });
      yield* session.ready;
      return { prepared, session } satisfies EnvironmentConnectionLease;
    });

    return ConnectionDriver.of({ connect });
  }),
);
