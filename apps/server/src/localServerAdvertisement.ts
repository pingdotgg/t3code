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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/unstable/http";

import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { LocalServerDiscoveryState } from "./localServerDiscoveryState.ts";
import { resolveLocalAdvertisementHttpBaseUrl } from "./startupAccess.ts";

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

/**
 * Publish a credential-free presence record so a desktop client running as the
 * same local user can find this `t3 serve` process.
 *
 * The record is written exactly once and carries no secret, so there is nothing
 * to rotate and nothing to revoke. A client that finds it proves it is the same
 * local user through `/api/auth/local-pair`, which is only open while this
 * function has activated `LocalServerDiscoveryState`.
 */
export const startLocalServerAdvertisement = Effect.fn("server.localAdvertisement.start")(
  function* (input: {
    readonly listeningAddress: HttpServer.Address;
    readonly platform?: NodeJS.Platform;
    readonly xdgRuntimeDirectory?: string;
  }) {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const discoveryState = yield* LocalServerDiscoveryState;
    const hostPlatform = yield* HostProcessPlatform;
    const hostEnvironment = yield* HostProcessEnvironment;
    const platform = input.platform ?? hostPlatform;
    const xdgRuntimeDirectory = input.xdgRuntimeDirectory ?? hostEnvironment.XDG_RUNTIME_DIR;
    const directory = resolveLocalServerAdvertisementDirectory({
      platform,
      xdgRuntimeDirectory,
      path,
    });
    const httpBaseUrl =
      input.listeningAddress._tag === "TcpAddress"
        ? resolveLocalAdvertisementHttpBaseUrl(
            serverConfig.host,
            input.listeningAddress.port,
            input.listeningAddress.hostname,
          )
        : null;
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

    const cleanup = Effect.gen(function* () {
      yield* discoveryState.deactivate;
      yield* fileSystem.remove(recordPath, { force: true }).pipe(Effect.ignore);
      yield* fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore);
    });
    yield* Effect.addFinalizer(() => cleanup);
    yield* discoveryState.activate({
      instanceId,
      httpBaseUrl,
      platform,
      xdgRuntimeDirectory,
    });

    const publishExit = yield* Effect.exit(
      writeAdvertisement({
        directory,
        recordPath,
        tempPath,
        record: {
          version: 1,
          instanceId,
          pid: process.pid,
          startedAt,
          httpBaseUrl,
          environmentId: environment.environmentId,
          label: environment.label,
        },
      }),
    );
    if (Exit.isFailure(publishExit)) {
      yield* cleanup;
      yield* Effect.logWarning("Local T3 Code server discovery is unavailable.", {
        recordPath,
        cause: publishExit.cause,
      });
      return;
    }
  },
);
