import {
  LocalServerAdvertisement,
  type LocalServerAdvertisement as LocalServerAdvertisementRecord,
} from "@t3tools/contracts";
import {
  LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_MODE,
  LOCAL_SERVER_ADVERTISEMENT_FILE_MODE,
  resolveLocalServerAdvertisementDirectory,
} from "@t3tools/shared/localServerDiscovery";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import {
  buildPairingUrl,
  resolveLocalAdvertisementHttpBaseUrl,
  type HeadlessServeAccessInfo,
} from "./startupAccess.ts";

const REFRESH_MARGIN_MS = 60_000;
const MINIMUM_REFRESH_DELAY_MS = 1_000;

export function resolveAdvertisementRefreshDelayMs(input: {
  readonly nowMs: number;
  readonly pairingExpiresAt: string;
}): number {
  const expiresAtMs = Date.parse(input.pairingExpiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return MINIMUM_REFRESH_DELAY_MS;
  }
  return Math.max(MINIMUM_REFRESH_DELAY_MS, expiresAtMs - input.nowMs - REFRESH_MARGIN_MS);
}

const encodeAdvertisement = Schema.encodeUnknownEffect(
  Schema.fromJsonString(LocalServerAdvertisement),
);

const writeAdvertisement = Effect.fn("server.localAdvertisement.write")(function* (input: {
  readonly directory: string;
  readonly recordPath: string;
  readonly tempPath: string;
  readonly record: LocalServerAdvertisementRecord;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(input.directory, {
    recursive: true,
    mode: LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_MODE,
  });
  yield* fileSystem.chmod(input.directory, LOCAL_SERVER_ADVERTISEMENT_DIRECTORY_MODE);
  const encoded = yield* encodeAdvertisement(input.record);
  yield* Effect.gen(function* () {
    yield* fileSystem.writeFileString(input.tempPath, `${encoded}\n`, {
      mode: LOCAL_SERVER_ADVERTISEMENT_FILE_MODE,
    });
    yield* fileSystem.chmod(input.tempPath, LOCAL_SERVER_ADVERTISEMENT_FILE_MODE);
    yield* fileSystem.rename(input.tempPath, input.recordPath);
    yield* fileSystem.chmod(input.recordPath, LOCAL_SERVER_ADVERTISEMENT_FILE_MODE);
  }).pipe(Effect.ensuring(fileSystem.remove(input.tempPath, { force: true }).pipe(Effect.ignore)));
});

export const startLocalServerAdvertisement = Effect.fn("server.localAdvertisement.start")(
  function* (input: {
    readonly initialAccessInfo: HeadlessServeAccessInfo;
    readonly platform?: NodeJS.Platform;
    readonly xdgRuntimeDirectory?: string;
  }) {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const hostPlatform = yield* HostProcessPlatform;
    const hostEnvironment = yield* HostProcessEnvironment;
    const platform = input.platform ?? hostPlatform;
    const xdgRuntimeDirectory = input.xdgRuntimeDirectory ?? hostEnvironment.XDG_RUNTIME_DIR;
    const directory = resolveLocalServerAdvertisementDirectory({
      platform,
      xdgRuntimeDirectory,
      path,
    });
    const port = Number(new URL(input.initialAccessInfo.connectionString).port);
    const httpBaseUrl = resolveLocalAdvertisementHttpBaseUrl(serverConfig.host, port);
    if (
      directory === null ||
      httpBaseUrl === null ||
      serverConfig.startupPresentation !== "headless"
    ) {
      return;
    }

    const instanceId = yield* crypto.randomUUIDv4;
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    const environment = yield* serverEnvironment.getDescriptor;
    const recordPath = path.join(directory, `${instanceId}.json`);
    const tempPath = path.join(directory, `.${instanceId}.${process.pid}.tmp`);
    const currentAccessInfo = yield* Ref.make(input.initialAccessInfo);

    const publish = Effect.fn("server.localAdvertisement.publish")(function* (
      accessInfo: HeadlessServeAccessInfo,
    ) {
      yield* writeAdvertisement({
        directory,
        recordPath,
        tempPath,
        record: {
          version: 1,
          instanceId,
          pid: process.pid,
          startedAt,
          httpBaseUrl,
          pairingUrl: buildPairingUrl(httpBaseUrl, accessInfo.token),
          pairingExpiresAt: accessInfo.pairingExpiresAt,
          environmentId: environment.environmentId,
          label: environment.label,
        },
      });
    });

    const revoke = (accessInfo: HeadlessServeAccessInfo) =>
      serverAuth.revokePairingLink(accessInfo.pairingCredentialId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not revoke a local discovery pairing credential.", {
            pairingCredentialId: accessInfo.pairingCredentialId,
            error,
          }),
        ),
      );

    const issueAccessInfo = serverAuth.issueStartupPairingCredential().pipe(
      Effect.map(
        (issued): HeadlessServeAccessInfo => ({
          pairingCredentialId: issued.id,
          connectionString: input.initialAccessInfo.connectionString,
          token: issued.credential,
          pairingUrl: buildPairingUrl(input.initialAccessInfo.connectionString, issued.credential),
          pairingExpiresAt: DateTime.formatIso(issued.expiresAt),
        }),
      ),
    );

    const cleanup = Effect.gen(function* () {
      yield* fileSystem.remove(recordPath, { force: true }).pipe(Effect.ignore);
      yield* fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore);
      yield* revoke(yield* Ref.get(currentAccessInfo));
    });

    const initialPublish = yield* Effect.exit(publish(input.initialAccessInfo));
    if (Exit.isFailure(initialPublish)) {
      yield* Effect.logWarning("Local T3 Code server discovery is unavailable.", {
        recordPath,
        cause: initialPublish.cause,
      });
      return;
    }

    const rotate = Effect.forever(
      Effect.gen(function* () {
        const current = yield* Ref.get(currentAccessInfo);
        const now = yield* DateTime.now;
        yield* Effect.sleep(
          Duration.millis(
            resolveAdvertisementRefreshDelayMs({
              nowMs: DateTime.toEpochMillis(now),
              pairingExpiresAt: current.pairingExpiresAt,
            }),
          ),
        );
        const nextExit = yield* Effect.exit(issueAccessInfo);
        if (Exit.isFailure(nextExit)) {
          yield* Effect.logWarning("Could not rotate a local discovery pairing credential.", {
            cause: nextExit.cause,
          });
          return;
        }

        const next = nextExit.value;
        const publishExit = yield* Effect.exit(publish(next));
        if (Exit.isFailure(publishExit)) {
          yield* Effect.logWarning("Could not refresh the local server discovery record.", {
            recordPath,
            cause: publishExit.cause,
          });
          yield* revoke(next);
          return;
        }
        yield* Ref.set(currentAccessInfo, next);
        yield* revoke(current);
      }),
    );

    yield* Effect.forkScoped(rotate.pipe(Effect.ensuring(cleanup)));
  },
);
