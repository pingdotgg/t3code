import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ConnectionCredential } from "./catalog.ts";
import type { ConnectionAttemptError } from "./model.ts";

export class ConnectionCredentialStore extends Context.Service<
  ConnectionCredentialStore,
  {
    readonly get: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<ConnectionCredential>, ConnectionAttemptError>;
    readonly put: (
      connectionId: string,
      credential: ConnectionCredential,
    ) => Effect.Effect<void, ConnectionAttemptError>;
    /** Tracks explicit authentication eviction even if reconciliation stores the old token again. */
    readonly wasRejected?: (
      connectionId: string,
      credential: ConnectionCredential,
    ) => Effect.Effect<boolean, ConnectionAttemptError>;
    /** Atomically removes only the credential that failed authentication. */
    readonly removeIfMatches?: (
      connectionId: string,
      credential: ConnectionCredential,
    ) => Effect.Effect<void, ConnectionAttemptError>;
    readonly remove: (connectionId: string) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/credentialStore/ConnectionCredentialStore") {}

export const make = (service: ConnectionCredentialStore["Service"]) =>
  ConnectionCredentialStore.of(service);

/** A store that lives only as long as its layer, for tests and other throwaway runtimes. */
export const layerMemory = (initial: Iterable<readonly [string, ConnectionCredential]> = []) =>
  Layer.sync(ConnectionCredentialStore, () => {
    const stored = new Map(initial);
    return make({
      get: (connectionId) => Effect.sync(() => Option.fromNullishOr(stored.get(connectionId))),
      put: (connectionId, credential) =>
        Effect.sync(() => void stored.set(connectionId, credential)),
      remove: (connectionId) => Effect.sync(() => void stored.delete(connectionId)),
    });
  });
