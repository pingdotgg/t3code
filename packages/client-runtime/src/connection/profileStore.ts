import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";

import type { ConnectionProfile } from "./catalog.ts";
import type { ConnectionAttemptError } from "./model.ts";

export class ConnectionProfileStore extends Context.Service<
  ConnectionProfileStore,
  {
    readonly get: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<ConnectionProfile>, ConnectionAttemptError>;
    readonly put: (profile: ConnectionProfile) => Effect.Effect<void, ConnectionAttemptError>;
    readonly remove: (connectionId: string) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/profileStore/ConnectionProfileStore") {}

export const make = (service: ConnectionProfileStore["Service"]) =>
  ConnectionProfileStore.of(service);

export const layer = (service: ConnectionProfileStore["Service"]) =>
  Layer.succeed(ConnectionProfileStore, make(service));
