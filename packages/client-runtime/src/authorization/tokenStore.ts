import { EnvironmentId } from "@t3tools/contracts";
import { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectionAttemptError } from "../connection/model.ts";

export class RemoteDpopAccessToken extends Schema.Class<RemoteDpopAccessToken>(
  "@t3tools/client-runtime/authorization/RemoteDpopAccessToken",
)({
  environmentId: EnvironmentId,
  label: Schema.String,
  endpoint: RelayManagedEndpoint,
  accessToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  dpopThumbprint: Schema.String,
}) {}

export class RemoteDpopAccessTokenStore extends Context.Service<
  RemoteDpopAccessTokenStore,
  {
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<RemoteDpopAccessToken>, ConnectionAttemptError>;
    readonly put: (token: RemoteDpopAccessToken) => Effect.Effect<void, ConnectionAttemptError>;
    readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/tokenStore/RemoteDpopAccessTokenStore") {}

export const make = (service: RemoteDpopAccessTokenStore["Service"]) =>
  RemoteDpopAccessTokenStore.of(service);

export const layer = (service: RemoteDpopAccessTokenStore["Service"]) =>
  Layer.succeed(RemoteDpopAccessTokenStore, make(service));
