import {
  type AuthClientPresentationMetadata,
  type AuthEnvironmentScope,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type DesktopTailcatEnvironmentBootstrap,
  type TailcatConnectionCodePayload,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ConnectionAttemptError } from "../connection/model.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly bearerToken: string;
}

export interface ProvisionedSshEnvironment extends PreparedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export class CloudSession extends Context.Service<
  CloudSession,
  {
    readonly clerkToken: Effect.Effect<string, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/CloudSession") {}

export class RelayDeviceIdentity extends Context.Service<
  RelayDeviceIdentity,
  {
    readonly deviceId: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/RelayDeviceIdentity") {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }
>()("@t3tools/client-runtime/platform/capabilities/ClientPresentation") {}

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export interface PreparedTailcatEnvironment {
  readonly bootstrap: DesktopTailcatEnvironmentBootstrap;
}

export interface ProvisionedTailcatEnvironment extends PreparedTailcatEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly bearerToken: string;
}

/**
 * The platform's Tailcat transport. Desktop implements it with a managed
 * forwarder in the main process; web and mobile report it as unsupported,
 * because a browser or phone has no process to run tailcat in.
 */
export class TailcatEnvironmentGateway extends Context.Service<
  TailcatEnvironmentGateway,
  {
    /**
     * Establishes the forward for a pasted code and pairs with T3 auth. The
     * connection id is minted by onboarding so the forwarder and the saved
     * profile always agree on it.
     */
    readonly provision: (input: {
      readonly payload: TailcatConnectionCodePayload;
      readonly connectionId: string;
    }) => Effect.Effect<ProvisionedTailcatEnvironment, ConnectionAttemptError>;
    /** Ensures a live forward exists for a saved environment. */
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly address: string;
      readonly remotePort: number;
    }) => Effect.Effect<PreparedTailcatEnvironment, ConnectionAttemptError>;
    readonly disconnect: (connectionId: string) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/TailcatEnvironmentGateway") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    readonly provision: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<ProvisionedSshEnvironment, ConnectionAttemptError>;
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/platform/capabilities/SshEnvironmentGateway") {}
