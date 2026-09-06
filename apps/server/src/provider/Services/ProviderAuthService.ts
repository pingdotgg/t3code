import type { ProviderAuthState, ProviderInstanceId, ProviderSetupError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface ProviderAuthController {
  readonly start: (
    ownerSessionId: string,
    stopSessions?: Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly complete: (
    ownerSessionId: string,
    input: { readonly flowId: string; readonly callbackUrl: string },
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly cancel: (
    ownerSessionId: string,
    flowId: string,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  /** The controller closes process admission before it stops routed sessions. */
  readonly logout: (
    stopSessions: Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly subscribe: (ownerSessionId: string) => Stream.Stream<ProviderAuthState>;
  readonly isLogoutPrompt?: (text: string, hasAttachments: boolean) => boolean;
}

interface ProviderAuthTarget {
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderAuthServiceShape {
  readonly start: (
    input: ProviderAuthTarget,
    ownerSessionId: string,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly complete: (
    input: ProviderAuthTarget & { readonly flowId: string; readonly callbackUrl: string },
    ownerSessionId: string,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly cancel: (
    input: ProviderAuthTarget & { readonly flowId: string },
    ownerSessionId: string,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly logout: (
    input: ProviderAuthTarget,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly subscribe: (
    input: ProviderAuthTarget,
    ownerSessionId: string,
  ) => Stream.Stream<ProviderAuthState, ProviderSetupError>;
  readonly tryHandlePromptCommand: (
    input: ProviderAuthTarget & { readonly text: string; readonly hasAttachments: boolean },
  ) => Effect.Effect<boolean, ProviderSetupError>;
}

export class ProviderAuthService extends Context.Service<
  ProviderAuthService,
  ProviderAuthServiceShape
>()("t3/provider/Services/ProviderAuthService") {}
