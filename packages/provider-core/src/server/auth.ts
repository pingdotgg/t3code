import type {
  ChatGptReconnectProfile,
  ChatGptTransferredProfile,
  ProviderAuthRespondInput,
  ProviderAuthState,
  ProviderSetupError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export interface ProviderAuthController {
  /** Equal keys mean these instances share credentials on this environment. */
  readonly credentialBinding?: { readonly owner: "provider" | "t3"; readonly key: string };
  readonly reconnectProfile?: (
    methodId: string,
  ) => Effect.Effect<ChatGptReconnectProfile | null, ProviderSetupError>;
  readonly importProfile?: (
    profile: ChatGptTransferredProfile,
    stopSessions: Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly adoptCredentials?: (
    update: Effect.Effect<void, ProviderSetupError>,
    stopSessions: Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly isChangingCredentials?: Effect.Effect<boolean>;
  readonly invalidate?: Effect.Effect<void>;
  readonly refreshMethods?: Effect.Effect<void>;
  readonly withAccess?: <A, E, R>(
    task: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSetupError, R | Scope.Scope>;
  readonly start: (
    ownerSessionId: string,
    stopSessions?: Effect.Effect<void, ProviderSetupError>,
    methodId?: string,
    returnUrl?: string,
    callbackMode?: "server" | "client",
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly complete: (
    ownerSessionId: string,
    input: { readonly flowId: string; readonly callbackUrl: string },
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly cancel: (
    ownerSessionId: string,
    flowId: string,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly respond?: (
    ownerSessionId: string,
    input: ProviderAuthRespondInput,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  /** The controller closes process admission before it stops routed sessions. */
  readonly logout: (
    stopSessions: Effect.Effect<void, ProviderSetupError>,
  ) => Effect.Effect<ProviderAuthState, ProviderSetupError>;
  readonly subscribe: (ownerSessionId: string) => Stream.Stream<ProviderAuthState>;
  readonly isLogoutPrompt?: (text: string, hasAttachments: boolean) => boolean;
}
