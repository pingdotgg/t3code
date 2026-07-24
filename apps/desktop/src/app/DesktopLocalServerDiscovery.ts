import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  LocalServerAdvertisement,
  type LocalServerAdvertisement as LocalServerAdvertisementRecord,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import {
  isValidLocalServerPairingUrl,
  LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_MODE,
  LOCAL_SERVER_ADVERTISEMENT_FILE_MODE,
  LOCAL_SERVER_ADVERTISEMENT_MAX_BYTES,
  parseCanonicalLoopbackHttpBaseUrl,
  resolveLocalServerAdvertisementDirectory,
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

const decodeAdvertisement = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LocalServerAdvertisement),
);

type ProbeEnvironment = (
  httpBaseUrl: string,
) => Effect.Effect<ExecutionEnvironmentDescriptor | null>;

export interface DesktopLocalServerDiscoveryOptions {
  readonly platform: NodeJS.Platform;
  readonly xdgRuntimeDirectory: string | undefined;
  readonly uid: number | undefined;
  readonly probeEnvironment: ProbeEnvironment;
}

export class DesktopLocalServerDiscovery extends Context.Service<
  DesktopLocalServerDiscovery,
  {
    readonly discover: Effect.Effect<ReadonlyArray<LocalServerAdvertisementRecord>>;
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

function hasValidTimestamps(record: LocalServerAdvertisementRecord, nowMs: number): boolean {
  const startedAtMs = Date.parse(record.startedAt);
  const expiresAtMs = Date.parse(record.pairingExpiresAt);
  return (
    Number.isFinite(startedAtMs) &&
    Number.isFinite(expiresAtMs) &&
    startedAtMs <= nowMs + 60_000 &&
    expiresAtMs > nowMs
  );
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
          if (Option.isNone(decoded) || !hasValidTimestamps(decoded.value, nowMs)) {
            return null;
          }

          const httpBaseUrl = parseCanonicalLoopbackHttpBaseUrl(decoded.value.httpBaseUrl);
          if (
            httpBaseUrl === null ||
            !isValidLocalServerPairingUrl({
              pairingUrl: decoded.value.pairingUrl,
              httpBaseUrl,
            })
          ) {
            return null;
          }

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

  return DesktopLocalServerDiscovery.of({ discover });
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
    });
  }),
);
