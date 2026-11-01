/**
 * Expo's GraphQL API for EAS Simulator sessions. The operations in
 * `ExpoApi.graphql` are the ones eas-cli's `simulator:*` commands send; their
 * client is generated from `schema/expo.graphql` (`vp run generate`).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  GraphQLClient,
  GraphQLClientError,
  GraphQLMiddleware,
  GraphQLProtocol,
} from "effect/graphql";
import { HttpClient } from "effect/http";
import * as Headers from "effect/http/Headers";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { ExpoApiGraphQLGroup, type T3EasSimulatorSession } from "./ExpoApi.graphql.ts";
import type { DeviceRunSessionStatus } from "../../schema/expo.graphql.ts";

const EXPO_GRAPHQL_URL = "https://api.expo.dev/graphql";
const REQUEST_TIMEOUT = "30 seconds";

export type ExpoCredentialSource = "settings" | "env" | "eas-login";

export interface ExpoCredential {
  readonly source: ExpoCredentialSource;
  readonly header: {
    readonly name: "authorization" | "expo-session";
    readonly value: Redacted.Redacted<string>;
  };
}

export class ExpoNotSignedInError extends Schema.TaggedError<ExpoNotSignedInError>()(
  "ExpoNotSignedInError",
  {},
) {
  override get message(): string {
    return "No Expo credential on the server: save an access token for this host, set EXPO_TOKEN, or run `eas login`.";
  }
}

const CREDENTIAL_SOURCE_NAMES: Record<ExpoCredentialSource, string> = {
  settings: "The access token saved for this host",
  env: "EXPO_TOKEN",
  "eas-login": "The eas login session",
};

export class ExpoInvalidCredentialError extends Schema.TaggedError<ExpoInvalidCredentialError>()(
  "ExpoInvalidCredentialError",
  { source: Schema.Literals(["settings", "env", "eas-login"]) },
) {
  override get message(): string {
    return `${CREDENTIAL_SOURCE_NAMES[this.source]} is not a usable Expo credential. Replace it.`;
  }
}

/**
 * Expo credentials are printable ASCII. Anything else (the redacted
 * placeholder, a pasted newline) would fail inside fetch with the header
 * value in its message, so it is refused here.
 */
const credential = (
  source: ExpoCredentialSource,
  header: ExpoCredential["header"]["name"],
  value: string,
) =>
  /^[\x21-\x7e]+$/.test(value)
    ? Effect.succeed({
        source,
        header: {
          name: header,
          value: Redacted.make(header === "authorization" ? `Bearer ${value}` : value),
        },
      } satisfies ExpoCredential)
    : Effect.fail(new ExpoInvalidCredentialError({ source }));

export class ExpoApiError extends Schema.TaggedError<ExpoApiError>()("ExpoApiError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  /**
   * Expo answered and refused, so a mutation did nothing. Otherwise (no
   * answer, a server error, an answer that did not decode) it may have run.
   */
  rejected: Schema.optional(Schema.Boolean),
  /** The HTTP status Expo answered with, when it answered. */
  status: Schema.optional(Schema.Int),
}) {
  override get message(): string {
    return `Expo could not ${this.operation}${this.detail ? `: ${this.detail}` : "."}`;
  }
}

/** `eas login` and `expo login` keep the session secret here. */
const ExpoState = Schema.fromJsonString(
  Schema.Struct({
    auth: Schema.optional(
      Schema.NullOr(
        Schema.Struct({ sessionSecret: Schema.optional(Schema.NullOr(Schema.String)) }),
      ),
    ),
  }),
);
const decodeExpoState = Schema.decodeUnknownOption(ExpoState);

/** A token saved for the host, then EXPO_TOKEN, then the `eas login` session. */
export const resolveExpoCredential = Effect.fn("ExpoApi.resolveExpoCredential")(function* (
  savedToken: string,
) {
  const saved = savedToken.trim();
  if (saved !== "") return yield* credential("settings", "authorization", saved);
  const fromEnv = (yield* HostProcess.Environment).EXPO_TOKEN?.trim();
  if (fromEnv) return yield* credential("env", "authorization", fromEnv);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(yield* HostProcess.HomeDirectory, ".expo", "state.json");
  const state = yield* fs.readFileString(statePath).pipe(Effect.option);
  const secret = Option.flatMap(state, decodeExpoState).pipe(
    Option.flatMap((value) => Option.fromNullishOr(value.auth?.sessionSecret?.trim() || null)),
  );
  if (Option.isNone(secret)) return yield* new ExpoNotSignedInError();
  return yield* credential("eas-login", "expo-session", secret.value);
});

export type EasSessionStatus = DeviceRunSessionStatus;

export interface EasSession {
  readonly id: string;
  readonly status: EasSessionStatus;
  /** Present once the simulator is ready; tokens grant full device control. */
  readonly endpoints: {
    readonly agentDevice: { readonly url: string; readonly token: Redacted.Redacted<string> };
    readonly preview: { readonly url: string; readonly token: Redacted.Redacted<string> } | null;
  } | null;
}

export interface EasApp {
  readonly id: string;
  readonly fullName: string;
}

export interface CreateEasSessionInput {
  readonly appId: string;
  readonly platform: "ios" | "android";
  readonly name: string;
  readonly maxRunTimeMinutes: number;
  readonly maxIdleTimeMinutes: number;
}

const DEVICE_RUN_SESSIONS_GATE = "device-run-sessions";
const isFeatureGates = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** Sends every operation with the resolved credential. */
class ExpoAuth extends GraphQLMiddleware.Service<ExpoAuth>()("t3/server/device/ExpoApi/ExpoAuth") {}

const ExpoGroup = ExpoApiGraphQLGroup.middleware(ExpoAuth);

/**
 * Expo's answer as an `ExpoApiError`, which has no cause: a transport error's
 * holds the request with its credential header, and a decode error's can
 * quote session tokens. These errors also travel to clients as RPC defects.
 */
const toExpoApiError = (
  operation: string,
  credential: ExpoCredential,
  error: GraphQLClientError.GraphQLClientError,
): ExpoApiError => {
  const reason = error.reason;
  const status =
    reason._tag === "TransportError" || reason._tag === "ResponseError" ? reason.status : undefined;
  // Expo user errors have `errorType: "USER"`, no `isTransient`, and null data (eas-cli's rule).
  // Apollo's `code` is unreliable: Expo also uses INTERNAL_SERVER_ERROR for user errors.
  // GraphQL errors at 5xx, beside data, or caused by Expo may follow a request that ran.
  const errors = reason._tag === "ResponseError" ? reason.errors : [];
  const fault = errors.some(
    ({ extensions }) =>
      extensions?.isTransient === true ||
      (extensions?.errorType !== undefined && extensions.errorType !== "USER") ||
      extensions?.errorCode === "INTERNAL_SERVER_ERROR",
  );
  const usersFault =
    errors.length > 0 && errors.every(({ extensions }) => extensions?.errorType === "USER");
  const uncertain =
    reason._tag === "ResponseError" &&
    (fault || (reason.data !== undefined && !(reason.data === null && usersFault)));
  const rejected =
    reason._tag === "EncodeError" ||
    (status !== undefined &&
      status < 500 &&
      !uncertain &&
      (status >= 400 || reason._tag === "ResponseError"));
  // Expo's own messages are the reason the user acts on, but nothing promises
  // they never echo a request: the credential is cut out, and they are bounded.
  const secret = Redacted.value(credential.header.value);
  const token = secret.replace(/^Bearer /, "");
  const scrub = (text: string) =>
    text.replaceAll(secret, "[redacted]").replaceAll(token, "[redacted]").slice(0, 300);
  const failure = (detail: string) =>
    new ExpoApiError({
      operation,
      detail: scrub(detail),
      rejected,
      ...(status !== undefined ? { status } : {}),
    });
  if (status === 401 || status === 403) {
    const what = credential.source === "eas-login" ? "eas login session" : "access token";
    return failure(`the ${what} was rejected (HTTP ${status})`);
  }
  switch (reason._tag) {
    case "ResponseError":
      return failure(reason.errors.map((graphQlError) => graphQlError.message).join("; "));
    case "TransportError":
      return failure(
        status === undefined ? "Expo's API is unreachable" : `unexpected response (HTTP ${status})`,
      );
    case "EncodeError":
      return failure("the request could not be encoded");
    default:
      return failure("unexpected response");
  }
};

const toSession = (
  session: T3EasSimulatorSession.Result["deviceRunSessions"]["byId"],
): EasSession => {
  const remote = session.remoteConfig;
  return {
    id: session.id,
    status: session.status,
    endpoints:
      remote?.__typename === "AgentDeviceRunSessionRemoteConfig"
        ? {
            agentDevice: {
              url: remote.agentDeviceRemoteSessionUrl,
              token: Redacted.make(remote.agentDeviceRemoteSessionToken),
            },
            preview:
              remote.previewApiUrl && remote.webPreviewToken
                ? { url: remote.previewApiUrl, token: Redacted.make(remote.webPreviewToken) }
                : null,
          }
        : null,
  };
};

/** Typed calls against Expo's API with one resolved credential. */
export const makeExpoApi = (http: HttpClient.HttpClient, credential: ExpoCredential) => {
  const client = GraphQLClient.make(ExpoGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          ExpoAuth,
          GraphQLMiddleware.mapRequest((request) =>
            Effect.succeed({
              ...request,
              headers: Headers.set(
                request.headers,
                credential.header.name,
                Redacted.value(credential.header.value),
              ),
            }),
          ),
        ),
        GraphQLProtocol.layerHttp({ url: EXPO_GRAPHQL_URL }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        ),
      ),
    ),
  );
  const call = <A>(
    operation: string,
    run: (
      client: GraphQLClient.FromGroup<typeof ExpoGroup>,
    ) => Effect.Effect<A, GraphQLClientError.GraphQLClientError>,
  ) =>
    Effect.flatMap(client, run).pipe(
      Effect.mapError((error) => toExpoApiError(operation, credential, error)),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new ExpoApiError({ operation, detail: "Expo's API did not answer in time" })),
      }),
      Effect.withSpan(`ExpoApi.${operation}`),
    );

  return {
    credential,
    viewer: call("read the signed-in account", (expo) => expo.T3ExpoViewer()).pipe(
      Effect.flatMap(({ meActor }) =>
        meActor === null
          ? Effect.fail(
              new ExpoApiError({
                operation: "read the signed-in account",
                detail: "no account is signed in",
              }),
            )
          : Effect.succeed({
              name:
                "username" in meActor
                  ? meActor.username
                  : "firstName" in meActor
                    ? (meActor.firstName ?? meActor.__typename)
                    : meActor.__typename,
              apps: meActor.accounts.flatMap((account) =>
                account.appsPaginated.edges.map(({ node }): EasApp => node),
              ),
            }),
      ),
    ),
    availability: (appId: string) =>
      call("check EAS Simulator access", (expo) =>
        expo.T3EasSimulatorAvailability({ appId, filter: [DEVICE_RUN_SESSIONS_GATE] }),
      ).pipe(
        Effect.map(({ app }) => {
          const gates = app.byId.ownerAccount.accountFeatureGates;
          return {
            account: app.byId.ownerAccount.name,
            available: isFeatureGates(gates) && gates[DEVICE_RUN_SESSIONS_GATE] === true,
          };
        }),
      ),
    create: (input: CreateEasSessionInput) =>
      call("start a simulator session", (expo) =>
        expo.T3CreateEasSimulatorSession({
          input: {
            appId: input.appId,
            platform: input.platform === "ios" ? "IOS" : "ANDROID",
            type: "AGENT_DEVICE",
            name: input.name,
            maxRunTimeMinutes: input.maxRunTimeMinutes,
            maxIdleTimeMinutes: input.maxIdleTimeMinutes,
            // Expo only issues the preview host's API URL when preview access is configured.
            corsOrigins: ["http://localhost"],
          },
        }),
      ).pipe(Effect.map(({ deviceRunSession }) => deviceRunSession.createDeviceRunSession.id)),
    session: (id: string) =>
      call("read a simulator session", (expo) => expo.T3EasSimulatorSession({ id })).pipe(
        Effect.map(({ deviceRunSessions }) => toSession(deviceRunSessions.byId)),
      ),
    activeSessions: (appId: string) =>
      call("list simulator sessions", (expo) =>
        expo.T3ActiveEasSimulatorSessions({
          appId,
          filter: { statuses: ["NEW", "QUEUED", "STARTING", "IN_PROGRESS"] },
        }),
      ).pipe(
        Effect.map(({ app }) => app.byId.deviceRunSessionsPaginated.edges.map(({ node }) => node)),
      ),
    stop: (id: string) =>
      call("stop a simulator session", (expo) => expo.T3StopEasSimulatorSession({ id })).pipe(
        Effect.map(({ deviceRunSession }) => deviceRunSession.ensureDeviceRunSessionStopped.status),
      ),
  };
};

export type ExpoApi = ReturnType<typeof makeExpoApi>;
