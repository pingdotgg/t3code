import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { hashTelemetryId, isTelemetryIdHash } from "@t3tools/shared/telemetryId";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_ANALYTICS_ID,
  CLOUD_LINKED_USER_ID,
  readRelayConnection,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";

/**
 * Who an install belongs to, from strongest to weakest. `connect` is the T3
 * Connect account. `device` is a client device that connected.
 */
export const TelemetryOwnerSource = Schema.Literals(["connect", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  /** The relay-issued analytics id for `connect`, `hashTelemetryId` of the device id for `device`. */
  readonly ownerId: string;
}

class TelemetryIdentityReadError extends Schema.TaggedError<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read anonymous telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedError<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedError<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryAnonymousIdGenerationError
  | TelemetryAnonymousIdPersistenceError;

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const getTelemetryIdentityCauseAnnotations = (cause: unknown) => {
  if (cause instanceof PlatformError.PlatformError) {
    return {
      causeKind: "platform",
      platformReason: cause.reason._tag,
    };
  }
  return { causeKind: "other" };
};

const logTelemetryIdentityError = (error: TelemetryIdentityError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      filePath: error.filePath,
      ...getTelemetryIdentityCauseAnnotations(error.cause),
      ...(error.stack === undefined ? {} : { errorStack: error.stack }),
    }),
  );

const readIdentityFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(new TelemetryIdentityReadError({ filePath, cause })),
    }),
  );

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readIdentityFile(fileSystem, anonymousIdPath);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const anonymousId = yield* SecureRandom.SecureRandom.pipe(
    Effect.flatMap((crypto) => crypto.uuidV4()),
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdGenerationError({
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({ filePath: anonymousIdPath, contents: anonymousId }).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdPersistenceError({
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );

  return anonymousId;
});

/**
 * `distinctId` and `installId` are the same hash of a random id kept in the state
 * directory. Identity never comes from a provider's sign-in files or account. Both
 * names are sent because the ingest side reads each. Null disables telemetry.
 */
export const getTelemetryIdentity = upsertAnonymousId.pipe(
  Effect.map(hashTelemetryId),
  Effect.catch((error) => logTelemetryIdentityError(error).pipe(Effect.as(null))),
  Effect.map((installId) => ({ distinctId: installId, installId })),
  Effect.withSpan("getTelemetryIdentity"),
);

const readSecretString = (name: string) =>
  ServerSecretStore.ServerSecretStore.pipe(
    Effect.flatMap((secrets) => secrets.get(name)),
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
  );

/** Asks the relay once per link; the id is kept next to the linked account from then on. */
const fetchLinkedAnalyticsId = Effect.fn("fetchLinkedAnalyticsId")(function* (cloudUserId: string) {
  const connection = yield* readRelayConnection;
  if (connection === null || Option.isSome(yield* readSecretString(CLOUD_LINK_REVOKED))) {
    return Option.none<string>();
  }
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const client = yield* makeRelayEnvironmentClient(connection);
  const { analyticsId } = yield* client.server
    .getAnalyticsId({ params: { environmentId }, payload: { cloudUserId } })
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.timeout("10 seconds"),
    );
  // The account could have changed while the request was in flight.
  const linked = yield* readSecretString(CLOUD_LINKED_USER_ID);
  if (!isTelemetryIdHash(analyticsId) || Option.getOrNull(linked) !== cloudUserId) {
    return Option.none<string>();
  }
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.set(CLOUD_LINKED_ANALYTICS_ID, new TextEncoder().encode(analyticsId));
  return Option.some(analyticsId);
});

/**
 * The owner the server can read without a client: the linked T3 Connect
 * account, by the analytics id the relay issued it. Never derived from the
 * account id, so without that id there is no connect owner. Clients add
 * `connect` and `device` owners when they connect.
 */
export const getServerOwners = Effect.gen(function* () {
  const cloudUserId = yield* readSecretString(CLOUD_LINKED_USER_ID);
  if (Option.isNone(cloudUserId) || cloudUserId.value.trim() === "") {
    return Option.none<string>();
  }
  const stored = Option.filter(
    yield* readSecretString(CLOUD_LINKED_ANALYTICS_ID),
    isTelemetryIdHash,
  );
  return Option.isSome(stored) ? stored : yield* fetchLinkedAnalyticsId(cloudUserId.value);
}).pipe(
  Effect.catch((cause) =>
    Effect.logWarning("Failed to read the linked T3 Connect account for telemetry", {
      errorTag: cause._tag,
    }).pipe(Effect.as(Option.none<string>())),
  ),
  Effect.map((analyticsId) =>
    Option.isSome(analyticsId)
      ? [{ source: "connect", ownerId: analyticsId.value } satisfies TelemetryOwner]
      : [],
  ),
  Effect.withSpan("getServerOwners"),
);
