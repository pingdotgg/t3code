import { EnvironmentId } from "@t3tools/contracts";
import type { RelayManagedEndpoint } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ConnectionAttemptError, PreparedHttpAuthorization } from "../connection/model.ts";

export interface RelayEnvironmentAuthorization {
  readonly environmentId: EnvironmentId;
  readonly endpoint: RelayManagedEndpoint;
  readonly credential: string;
}

export interface AuthorizedRemoteEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization;
}

export class RemoteEnvironmentAuthorization extends Context.Service<
  RemoteEnvironmentAuthorization,
  {
    readonly authorizeBearer: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly bearerToken: string;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
    readonly authorizeDpop: (input: {
      readonly expectedEnvironmentId: EnvironmentId;
      readonly obtainBootstrap: Effect.Effect<
        RelayEnvironmentAuthorization,
        ConnectionAttemptError
      >;
    }) => Effect.Effect<AuthorizedRemoteEnvironment, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/authorization/service/RemoteEnvironmentAuthorization") {}
