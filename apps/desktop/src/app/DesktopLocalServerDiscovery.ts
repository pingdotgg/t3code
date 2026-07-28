import * as NodeCrypto from "node:crypto";

import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  LocalServerAdvertisement,
  LocalServerPairingResult,
  type LocalServerAdvertisement as LocalServerAdvertisementRecord,
  type LocalServerPairingChallenge,
  type LocalServerPairingResult as LocalServerPairingResultRecord,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import {
  LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_MODE,
  LOCAL_SERVER_ADVERTISEMENT_FILE_MODE,
  LOCAL_SERVER_ADVERTISEMENT_MAX_BYTES,
  LOCAL_SERVER_CHALLENGE_NONCE_BYTES,
  isValidLocalServerPairingUrl,
  parseCanonicalLoopbackHttpBaseUrl,
  resolveLocalServerAdvertisementDirectory,
  resolveLocalServerChallengeDirectory,
} from "@t3tools/shared/localServerDiscovery";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const decodeAdvertisement = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LocalServerAdvertisement),
);
const decodePairingResult = Schema.decodeUnknownEffect(LocalServerPairingResult);

const LOCAL_SERVER_CHALLENGE_DIRECTORY_MODE = 0o700;
const LOCAL_SERVER_CHALLENGE_FILE_MODE = 0o600;
const LOCAL_SERVER_PAIRING_PATH = "api/auth/local-pair";
const LOCAL_SERVER_PAIRING_TIMEOUT_MS = 10_000;

export class LocalServerPairingError extends Schema.TaggedErrorClass<LocalServerPairingError>()(
  "LocalServerPairingError",
  {
    reason: Schema.Literals(["unavailable", "not_found", "challenge_failed", "request_failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

type ProbeEnvironment = (
  httpBaseUrl: string,
) => Effect.Effect<ExecutionEnvironmentDescriptor | null>;

/**
 * Hands the challenge to the advertised server. Injected so tests can observe
 * the on-disk challenge without standing up an HTTP server; the real
 * implementation lives in {@link layer}.
 */
type PostPairingChallenge = (input: {
  readonly httpBaseUrl: string;
  readonly challenge: LocalServerPairingChallenge;
}) => Effect.Effect<LocalServerPairingResultRecord, LocalServerPairingError>;

export interface DesktopLocalServerDiscoveryOptions {
  readonly platform: NodeJS.Platform;
  readonly xdgRuntimeDirectory: string | undefined;
  readonly uid: number | undefined;
  readonly probeEnvironment: ProbeEnvironment;
  readonly postPairingChallenge: PostPairingChallenge;
}

export class DesktopLocalServerDiscovery extends Context.Service<
  DesktopLocalServerDiscovery,
  {
    readonly discover: Effect.Effect<ReadonlyArray<LocalServerAdvertisementRecord>>;
    /**
     * Performs the whole pairing handshake in the main process so the pairing
     * credential is minted on an explicit user action and never travels
     * through the renderer as ambient discovery data.
     */
    readonly pairLocalServer: (
      instanceId: string,
    ) => Effect.Effect<LocalServerPairingResultRecord, LocalServerPairingError>;
  }
>()("@t3tools/desktop/app/DesktopLocalServerDiscovery") {}

function ownedWithMode(input: {
  readonly actualUid: Option.Option<number>;
  readonly expectedUid: number | undefined;
  readonly actualMode: number;
  readonly expectedMode: number;
}): boolean {
  return (
    input.expectedUid !== undefined &&
    Option.getOrUndefined(input.actualUid) === input.expectedUid &&
    (input.actualMode & 0o777) === input.expectedMode
  );
}

/**
 * Advertisements no longer carry a credential and therefore no longer expire,
 * so there is nothing here that can prove liveness. `startedAt` is only sanity
 * checked: a record claiming to have started far in the future is malformed.
 * A stale record left behind by a dead process is rejected further down by the
 * environment-identity probe failing to reach the advertised loopback port.
 */
function hasValidStartedAt(record: LocalServerAdvertisementRecord, nowMs: number): boolean {
  const startedAtMs = Date.parse(record.startedAt);
  return Number.isFinite(startedAtMs) && startedAtMs <= nowMs + 60_000;
}

export const make = Effect.fn("desktop.localServerDiscovery.make")(function* (
  options: DesktopLocalServerDiscoveryOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = resolveLocalServerAdvertisementDirectory({
    platform: options.platform,
    xdgRuntimeDirectory: options.xdgRuntimeDirectory,
    path,
  });
  const challengeDirectory = resolveLocalServerChallengeDirectory({
    platform: options.platform,
    xdgRuntimeDirectory: options.xdgRuntimeDirectory,
    path,
  });

  const discover = Effect.gen(function* () {
    if (directory === null) {
      return [];
    }

    const directoryInfo = yield* fileSystem.stat(directory).pipe(Effect.option);
    if (
      Option.isNone(directoryInfo) ||
      directoryInfo.value.type !== "Directory" ||
      !ownedWithMode({
        actualUid: directoryInfo.value.uid,
        expectedUid: options.uid,
        actualMode: directoryInfo.value.mode,
        expectedMode: LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_MODE,
      })
    ) {
      return [];
    }

    const canonicalDirectory = yield* fileSystem.realPath(directory).pipe(Effect.option);
    if (Option.isNone(canonicalDirectory)) {
      return [];
    }
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);

    const discovered = yield* Effect.forEach(
      entries.filter((entry) => entry.endsWith(".json")),
      (entry) =>
        Effect.gen(function* () {
          const recordPath = path.join(directory, entry);
          const recordInfo = yield* fileSystem.stat(recordPath).pipe(Effect.option);
          if (
            Option.isNone(recordInfo) ||
            recordInfo.value.type !== "File" ||
            Number(recordInfo.value.size) > LOCAL_SERVER_ADVERTISEMENT_MAX_BYTES ||
            !ownedWithMode({
              actualUid: recordInfo.value.uid,
              expectedUid: options.uid,
              actualMode: recordInfo.value.mode,
              expectedMode: LOCAL_SERVER_ADVERTISEMENT_FILE_MODE,
            })
          ) {
            return null;
          }

          const canonicalRecordPath = yield* fileSystem.realPath(recordPath).pipe(Effect.option);
          if (
            Option.isNone(canonicalRecordPath) ||
            path.dirname(canonicalRecordPath.value) !== canonicalDirectory.value
          ) {
            return null;
          }

          const raw = yield* fileSystem.readFileString(recordPath).pipe(Effect.option);
          if (Option.isNone(raw)) {
            return null;
          }
          const decoded = yield* decodeAdvertisement(raw.value).pipe(Effect.option);
          if (Option.isNone(decoded) || !hasValidStartedAt(decoded.value, nowMs)) {
            return null;
          }

          if (parseCanonicalLoopbackHttpBaseUrl(decoded.value.httpBaseUrl) === null) {
            return null;
          }

          // Liveness check as well as an identity check: a record whose process
          // is gone has nothing listening on the advertised port, so the probe
          // fails and the advertisement drops out of the list.
          const descriptor = yield* options.probeEnvironment(decoded.value.httpBaseUrl);
          if (descriptor === null || descriptor.environmentId !== decoded.value.environmentId) {
            return null;
          }
          return {
            ...decoded.value,
            label: descriptor.label,
          } satisfies LocalServerAdvertisementRecord;
        }),
      { concurrency: 4 },
    );

    return discovered
      .filter((record): record is LocalServerAdvertisementRecord => record !== null)
      .toSorted(
        (left, right) =>
          left.label.localeCompare(right.label) || left.instanceId.localeCompare(right.instanceId),
      );
  });

  const pairLocalServer = Effect.fn("desktop.localServerDiscovery.pair")(function* (
    instanceId: string,
  ) {
    if (challengeDirectory === null) {
      return yield* new LocalServerPairingError({
        reason: "unavailable",
        detail: "Local server pairing is not supported on this platform.",
      });
    }

    // Re-run discovery so an explicit Pair click acts on a live, identity
    // verified advertisement rather than on a stale renderer snapshot.
    const advertisements = yield* discover;
    const advertisement = advertisements.find((candidate) => candidate.instanceId === instanceId);
    if (advertisement === undefined) {
      return yield* new LocalServerPairingError({
        reason: "not_found",
        detail: "This local server is no longer advertising itself.",
      });
    }

    const nonce = NodeCrypto.randomBytes(LOCAL_SERVER_CHALLENGE_NONCE_BYTES).toString("hex");
    const challengePath = path.join(
      challengeDirectory,
      `${NodeCrypto.randomBytes(16).toString("hex")}.nonce`,
    );

    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(challengeDirectory, {
        recursive: true,
        mode: LOCAL_SERVER_CHALLENGE_DIRECTORY_MODE,
      });
      // `makeDirectory` honours the umask and is a no-op when the directory
      // already exists, so tighten the mode unconditionally.
      yield* fileSystem.chmod(challengeDirectory, LOCAL_SERVER_CHALLENGE_DIRECTORY_MODE);
      yield* fileSystem.writeFileString(challengePath, nonce, {
        mode: LOCAL_SERVER_CHALLENGE_FILE_MODE,
      });
      yield* fileSystem.chmod(challengePath, LOCAL_SERVER_CHALLENGE_FILE_MODE);
    }).pipe(
      Effect.tapError(() => fileSystem.remove(challengePath).pipe(Effect.ignore)),
      Effect.mapError(
        (cause) =>
          new LocalServerPairingError({
            reason: "challenge_failed",
            detail: "Could not write the local pairing challenge.",
            cause,
          }),
      ),
    );

    // The nonce is the whole proof of local-user identity, so it must not
    // outlive the request regardless of how that request ends.
    const result = yield* options
      .postPairingChallenge({
        httpBaseUrl: advertisement.httpBaseUrl,
        challenge: { instanceId, challengePath, nonce },
      })
      .pipe(Effect.ensuring(fileSystem.remove(challengePath).pipe(Effect.ignore)));
    const httpBaseUrl = parseCanonicalLoopbackHttpBaseUrl(advertisement.httpBaseUrl);
    if (
      httpBaseUrl === null ||
      !isValidLocalServerPairingUrl({ pairingUrl: result.pairingUrl, httpBaseUrl })
    ) {
      return yield* new LocalServerPairingError({
        reason: "request_failed",
        detail: "The local T3 Code server returned an invalid pairing link.",
      });
    }
    return result;
  });

  return DesktopLocalServerDiscovery.of({ discover, pairLocalServer });
});

export const layer = Layer.effect(
  DesktopLocalServerDiscovery,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const platform = yield* HostProcessPlatform;
    const hostEnvironment = yield* HostProcessEnvironment;
    return yield* make({
      platform,
      xdgRuntimeDirectory: hostEnvironment.XDG_RUNTIME_DIR,
      uid: process.getuid?.(),
      probeEnvironment: (httpBaseUrl) =>
        fetchRemoteEnvironmentDescriptor({
          httpBaseUrl,
          timeoutMs: 2_000,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.orElseSucceed(() => null),
        ),
      postPairingChallenge: ({ httpBaseUrl, challenge }) =>
        Effect.gen(function* () {
          const url = new URL(LOCAL_SERVER_PAIRING_PATH, httpBaseUrl);
          const request = HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(url.toString()),
            challenge,
          );
          const response = yield* httpClient
            .execute(request)
            .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
          return yield* decodePairingResult(yield* response.json);
        }).pipe(
          Effect.timeout(LOCAL_SERVER_PAIRING_TIMEOUT_MS),
          Effect.mapError(
            (cause) =>
              new LocalServerPairingError({
                reason: "request_failed",
                detail: "The local T3 Code server rejected the pairing request.",
                cause,
              }),
          ),
        ),
    });
  }),
);
