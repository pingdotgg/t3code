import {
  fetchRemoteSessionState,
  RemoteEnvironmentAuthorization,
  resolveRemoteWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionCatalogEntry,
  ConnectionDriver,
  ConnectionResolver,
  Connectivity,
  CredentialStore,
  EnvironmentSupervisor,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  ProfileStore,
  type SupervisorConnectionState,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { startThreadTurn } from "@t3tools/client-runtime/operations";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import {
  type EnvironmentRpcInput,
  type EnvironmentSubscriptionRpcTag,
  type EnvironmentUnaryRpcTag,
  EnvironmentRpcUnavailableError,
  getInitialServerConfig,
  request,
  RpcSessionFactory,
  subscribe,
} from "@t3tools/client-runtime/rpc";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type AuthEnvironmentScope,
  type ExecutionEnvironmentDescriptor,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { clientPresentation, type T3Credential } from "./credential.ts";

export interface ConnectOptions {
  /** Shown in the environment's connection list. */
  readonly label?: string;
}

/** What the connected server offers this client. */
export interface T3Negotiation {
  readonly environment: ExecutionEnvironmentDescriptor;
  /** Granted scopes; undefined when the server does not report them. */
  readonly scopes: ReadonlyArray<AuthEnvironmentScope> | undefined;
}

export interface SendMessageInput {
  readonly threadId: ThreadId;
  readonly text: string;
  /** How to deliver while a run is active. Defaults to the server's choice. */
  readonly mode?: "auto" | "queue" | "steer" | "restart";
  /** Reuse the same ids to retry a send without duplicating it. */
  readonly commandId?: CommandId;
  readonly messageId?: MessageId;
}

const unsupportedRoute = (detail: string) =>
  Effect.fail(new ConnectionBlockedError({ reason: "unsupported", detail }));

/**
 * Authorizes saved bearer sessions only. External clients hold no cloud
 * identity, so relay (DPoP) routes are refused instead of attempted.
 */
const bearerAuthorization = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const relayUnsupported = unsupportedRoute(
    "External clients connect with a pairing link, not T3 Connect sign-in.",
  );
  return RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer: Effect.fn("T3Client.authorizeBearer")(
      function* (input) {
        // Check identity before the token reaches whatever now answers this URL.
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: input.httpBaseUrl,
        }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
        if (descriptor.environmentId !== input.expectedEnvironmentId) {
          return yield* environmentMismatchError({
            expected: input.expectedEnvironmentId,
            actual: descriptor.environmentId,
          });
        }
        const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: input.wsBaseUrl,
          httpBaseUrl: input.httpBaseUrl,
          bearerToken: input.bearerToken,
          clientMetadata: presentation.metadata,
          connectionMethod: input.connectionMethod,
        }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
        return {
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          httpBaseUrl: input.httpBaseUrl,
          socketUrl,
          httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
        };
      },
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    authorizeDpop: () => relayUnsupported,
    authorizeDpopHttp: () => relayUnsupported,
  });
});

const catalogEntry = (credential: T3Credential): ConnectionCatalogEntry => {
  const connectionId = `external:${credential.environmentId}`;
  return {
    target: new BearerConnectionTarget({
      environmentId: credential.environmentId,
      label: credential.label,
      connectionId,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId: credential.environmentId,
        label: credential.label,
        httpBaseUrl: credential.httpBaseUrl,
        wsBaseUrl: credential.wsBaseUrl,
      }),
    ),
    enabled: true,
  };
};

/**
 * Platform services for one credential. Nothing persists: the caller owns
 * credential storage, and a process has no foreground or network signals.
 */
const platformLayer = (credential: T3Credential, options: ConnectOptions) => {
  const entry = catalogEntry(credential);
  const connectionId = `external:${credential.environmentId}`;
  const stored = new BearerConnectionCredential({ token: Redacted.value(credential.token) });
  const presentation = Layer.succeed(
    ClientCapabilities.ClientPresentation,
    clientPresentation(options),
  );
  return Layer.mergeAll(
    Layer.effect(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      bearerAuthorization,
    ),
    Layer.succeed(
      CredentialStore.ConnectionCredentialStore,
      CredentialStore.make({
        get: (id) => Effect.succeed(id === connectionId ? Option.some(stored) : Option.none()),
        put: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ProfileStore.ConnectionProfileStore,
      ProfileStore.make({
        get: (id) => Effect.succeed(id === connectionId ? entry.profile : Option.none()),
        put: () => Effect.void,
        remove: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({ bearerToken: Effect.succeedNone }),
    ),
    Layer.succeed(
      ClientCapabilities.SshEnvironmentGateway,
      ClientCapabilities.SshEnvironmentGateway.of({
        provision: () =>
          unsupportedRoute("SSH environments are only available in the desktop app."),
        prepare: () => unsupportedRoute("SSH environments are only available in the desktop app."),
        disconnect: () => Effect.void,
      }),
    ),
  ).pipe(Layer.provideMerge(presentation));
};

const signalsLayer = Layer.mergeAll(
  Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never }),
  Wakeups.layer({ changes: Stream.never }),
);

const blockedFailure = (state: SupervisorConnectionState) =>
  state.lastFailure?._tag === "ConnectionBlockedError"
    ? state.lastFailure
    : new ConnectionBlockedError({
        reason: "configuration",
        detail: state.lastFailure?.detail ?? "The environment refused the connection.",
      });

/**
 * Builds an environment client over an existing connection driver. `connect`
 * supplies the real driver; tests supply a fake one.
 */
export const makeEnvironment = Effect.fn("T3Client.makeEnvironment")(function* (
  credential: T3Credential,
) {
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const supervisor = yield* EnvironmentSupervisor.make(catalogEntry(credential), {
    initiallyDesired: true,
  });
  const withSupervisor = Effect.provideService(
    EnvironmentSupervisor.EnvironmentSupervisor,
    supervisor,
  );

  // The state the latest lifecycle request replaced, as the supervisor
  // acknowledged it. Every later state reflects that request, so `ready`
  // skips this one and never reports a lease or outcome from before it.
  const superseded = yield* Ref.make(Option.none<SupervisorConnectionState>());
  const control = (request: EnvironmentSupervisor.SupervisorControl) =>
    supervisor.control(request).pipe(Effect.flatMap((replaced) => Ref.set(superseded, replaced)));

  /**
   * Waits for a live session. Transient failures keep retrying with backoff,
   * so bound this with a timeout; authentication, permission and protocol
   * failures fail at once.
   */
  const ready = Effect.gen(function* () {
    const stale = Option.getOrUndefined(yield* Ref.get(superseded));
    const state = yield* SubscriptionRef.changes(supervisor.state).pipe(
      Stream.filter(
        (state) =>
          state !== stale &&
          (state.phase === "connected" || state.phase === "blocked" || state.phase === "available"),
      ),
      // An ending session clears its lease while the phase still says
      // connected; the next state reports the recovery, so wait for it.
      Stream.filterEffect((state) =>
        state.phase === "connected"
          ? SubscriptionRef.get(supervisor.session).pipe(Effect.map(Option.isSome))
          : Effect.succeed(true),
      ),
      Stream.runHead,
    );
    if (Option.isNone(state) || state.value.phase === "available") {
      return yield* new EnvironmentRpcUnavailableError({
        environmentId: credential.environmentId,
        message: `${credential.label} is disconnected.`,
      });
    }
    if (state.value.phase === "blocked") {
      return yield* blockedFailure(state.value);
    }
  });

  const negotiation = Effect.gen(function* () {
    yield* ready;
    const config = yield* getInitialServerConfig().pipe(withSupervisor);
    const session = yield* fetchRemoteSessionState({
      httpBaseUrl: credential.httpBaseUrl,
      bearerToken: Redacted.value(credential.token),
    }).pipe(
      Effect.mapError((error) => mapRemoteEnvironmentError(error)),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return { environment: config.environment, scopes: session.scopes } satisfies T3Negotiation;
  });

  const call = <TTag extends EnvironmentUnaryRpcTag>(tag: TTag, input: EnvironmentRpcInput<TTag>) =>
    ready.pipe(Effect.andThen(request(tag, input)), withSupervisor);

  /** Follows replacement sessions after reconnects; it never ends on its own. */
  const watch = <TTag extends EnvironmentSubscriptionRpcTag>(
    tag: TTag,
    input: EnvironmentRpcInput<TTag>,
  ) =>
    Stream.fromEffect(ready).pipe(
      Stream.drain,
      Stream.concat(subscribe(tag, input)),
      Stream.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    );

  /** Projects and threads as of now. */
  const shell = watch(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}).pipe(
    Stream.filterMap((item) =>
      item.kind === "snapshot" ? Result.succeed(item.snapshot) : Result.fail(item),
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

  const sendMessage = Effect.fn("T3Client.sendMessage")(function* (input: SendMessageInput) {
    yield* ready;
    const commandId = input.commandId ?? CommandId.make(yield* crypto.randomUUIDv4);
    const messageId = input.messageId ?? MessageId.make(yield* crypto.randomUUIDv4);
    const result = yield* startThreadTurn({
      commandId,
      threadId: input.threadId,
      message: { messageId, role: "user", text: input.text, attachments: [] },
      // Only first-message thread launches read these; sends never launch.
      runtimeMode: "full-access",
      interactionMode: "default",
      dispatchMode: input.mode ?? "auto",
    }).pipe(withSupervisor, Effect.provideService(Crypto.Crypto, crypto));
    return { commandId, messageId, result };
  });

  return {
    environmentId: credential.environmentId,
    label: credential.label,
    /** Connection phase, attempt and last failure from the shared supervisor. */
    state: supervisor.state,
    ready,
    negotiation,
    request: call,
    subscribe: watch,
    shell,
    sendMessage,
    // These return once the supervisor has taken the request, so a later
    // `ready` or `request` sees its outcome, never the state it replaced.
    /** Skips any pending backoff and reconnects now. */
    retryNow: control("retry"),
    disconnect: control("disconnect"),
    reconnect: control("connect"),
  };
});

export type T3Environment = Effect.Success<ReturnType<typeof makeEnvironment>>;

/**
 * Connects to one paired environment for the lifetime of the current scope.
 * Call it once per credential to work with several environments.
 */
export const connect = Effect.fn("T3Client.connect")(function* (
  credential: T3Credential,
  options: ConnectOptions = {},
) {
  const driver = ConnectionDriver.layer.pipe(
    Layer.provide(Layer.mergeAll(ConnectionResolver.layer, RpcSessionFactory.layer({}))),
    Layer.provide(platformLayer(credential, options)),
  );
  const context = yield* Layer.build(Layer.merge(driver, signalsLayer));
  return yield* makeEnvironment(credential).pipe(Effect.provideContext(context));
});
