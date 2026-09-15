// @effect-diagnostics nodeBuiltinImport:off - Streaming SHA-256 uses Node's incremental digest.
import {
  ProviderDriverKind,
  type ProviderSetupError,
  type ProviderInstallState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../config.ts";
import { spawnAndCollect, parseGenericCliVersion } from "./providerSnapshot.ts";
import {
  isProviderInstallActive,
  makeProviderInstallOperation,
} from "./providerInstallOperation.ts";
import {
  ProviderCliInstallError,
  resolveProviderCliRelease,
  type CliInstallDriver,
  type ProviderCliRelease,
} from "./providerCliRelease.ts";

const InstalledRelease = Schema.Struct({
  version: Schema.String,
  executable: Schema.String,
  sha256: Schema.String,
});
const readInstalled = Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledRelease));
const encodeInstalled = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));

export const makeProviderCliInstallation = Effect.fn("makeProviderCliInstallation")(
  function* (options: {
    readonly baseDir: string;
    readonly resolveRelease?: (
      driver: CliInstallDriver,
    ) => ReturnType<typeof resolveProviderCliRelease>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const http = yield* HttpClient.HttpClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = path.join(options.baseDir, "tools", "provider-clis");
    const states = yield* Effect.forEach(["codex", "claudeAgent", "opencode"] as const, (driver) =>
      Effect.gen(function* () {
        const directory = path.join(root, driver);
        const state = yield* SubscriptionRef.make<ProviderInstallState>({
          driver: ProviderDriverKind.make(driver),
          operationId: null,
          phase: "idle" as const,
          downloadedBytes: 0,
          totalBytes: null,
          version: null,
          installedVersion: null,
          canRemove: yield* fs.exists(directory),
          message: null,
        });
        if (yield* fs.exists(path.join(directory, "installed.json"))) {
          yield* fs.readFileString(path.join(directory, "installed.json")).pipe(
            Effect.flatMap(readInstalled),
            Effect.flatMap((record) =>
              SubscriptionRef.update(state, (value) => ({
                ...value,
                installedVersion: record.version,
              })),
            ),
            Effect.ignore,
          );
        }
        return [
          driver,
          {
            state,
            gate: yield* Semaphore.make(1),
            operation: yield* makeProviderInstallOperation(state),
          },
        ] as const;
      }),
    );
    const entries = new Map(states);
    const entry = (driver: CliInstallDriver) => entries.get(driver)!;

    const install = Effect.fn("ProviderCliInstallation.install")(
      function* (
        driver: CliInstallDriver,
        activate: (executable: string) => Effect.Effect<void, ProviderSetupError>,
      ) {
        const { state } = entry(driver);
        const asset: ProviderCliRelease = yield* (
          options.resolveRelease ?? resolveProviderCliRelease
        )(driver).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(HttpClient.HttpClient, http),
        );
        const directory = path.join(root, driver);
        yield* fs.makeDirectory(directory, { recursive: true });
        const previous = yield* fs
          .readFileString(path.join(directory, "installed.json"))
          .pipe(Effect.flatMap(readInstalled), Effect.option);
        if (
          previous._tag === "Some" &&
          previous.value.sha256 === asset.sha256 &&
          path
            .resolve(previous.value.executable)
            .startsWith(`${path.resolve(directory)}${path.sep}`) &&
          (yield* fs.exists(previous.value.executable))
        ) {
          const check = yield* spawnAndCollect(
            previous.value.executable,
            ChildProcess.make(previous.value.executable, ["--version"], {
              stdin: "ignore",
              env: { DISABLE_AUTOUPDATER: "1" },
              extendEnv: true,
            }),
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.timeout("30 seconds"),
            Effect.option,
          );
          if (
            check._tag === "Some" &&
            check.value.code === 0 &&
            parseGenericCliVersion(check.value.stdout) === asset.version
          ) {
            yield* activate(previous.value.executable);
            yield* SubscriptionRef.update(state, (value) => ({
              ...value,
              phase: "succeeded" as const,
              version: asset.version,
              installedVersion: asset.version,
              message: "Already up to date.",
              canRemove: true,
            }));
            return;
          }
        }
        const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".download-" });
        const archive = path.join(staging, "download");
        const runtime = path.join(staging, "runtime");
        yield* fs.makeDirectory(runtime);
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          version: asset.version,
          totalBytes: asset.bytes,
          canRemove: true,
          message: `Downloading ${driver === "claudeAgent" ? "Claude stable" : driver} ${asset.version}.`,
        }));
        const hash = NodeCrypto.createHash("sha256");
        let downloadedBytes = 0;
        let lastProgress = yield* Clock.currentTimeMillis;
        const response = yield* http
          .execute(HttpClientRequest.get(asset.url))
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              downloadedBytes += chunk.byteLength;
              if (downloadedBytes > asset.bytes)
                return yield* Effect.fail(
                  new ProviderCliInstallError({
                    detail: "Download exceeded the official release size.",
                  }),
                );
              hash.update(chunk);
              const now = yield* Clock.currentTimeMillis;
              if (now - lastProgress >= 250 || downloadedBytes === asset.bytes) {
                lastProgress = now;
                yield* SubscriptionRef.update(state, (value) => ({ ...value, downloadedBytes }));
              }
            }),
          ),
          Stream.run(fs.sink(archive, { flag: "wx", mode: 0o600 })),
        );
        if (downloadedBytes !== asset.bytes || hash.digest("hex") !== asset.sha256) {
          return yield* Effect.fail(
            new ProviderCliInstallError({
              detail: "The download failed its size or SHA-256 check. Nothing was installed.",
            }),
          );
        }
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          phase: "extracting" as const,
          message: "Extracting the verified runtime.",
        }));
        const executable = path.join(runtime, asset.executable);
        if (asset.format === "binary") {
          yield* fs.rename(archive, executable);
        } else {
          // macOS and Windows ship bsdtar (including ZIP support); Linux releases use tar.gz.
          const result = yield* spawnAndCollect(
            "tar",
            ChildProcess.make("tar", ["-xf", archive, "-C", runtime], {
              stdin: "ignore",
            }),
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          if (result.code !== 0)
            return yield* Effect.fail(
              new ProviderCliInstallError({
                detail:
                  "Could not extract the runtime. Ensure tar is available on this environment.",
              }),
            );
        }
        const realExecutable = yield* fs.realPath(executable);
        const realRuntime = yield* fs.realPath(runtime);
        if (
          !realExecutable.startsWith(`${realRuntime}${path.sep}`) ||
          (yield* fs.stat(realExecutable)).type !== "File"
        ) {
          return yield* Effect.fail(
            new ProviderCliInstallError({
              detail: "The release does not contain the expected executable.",
            }),
          );
        }
        yield* fs.chmod(executable, 0o755);
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          phase: "verifying" as const,
          message: "Checking the downloaded runtime.",
        }));
        const probe = yield* spawnAndCollect(
          executable,
          ChildProcess.make(executable, ["--version"], {
            stdin: "ignore",
            env: { DISABLE_AUTOUPDATER: "1" },
            extendEnv: true,
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeout("30 seconds"),
        );
        if (probe.code !== 0 || parseGenericCliVersion(probe.stdout) !== asset.version) {
          return yield* Effect.fail(
            new ProviderCliInstallError({
              detail: "The downloaded runtime did not report the expected version.",
            }),
          );
        }
        const operationId = (yield* SubscriptionRef.get(state)).operationId;
        const destination = path.join(directory, `${asset.sha256}-${operationId}`);
        yield* fs.rename(runtime, destination);
        const selectedExecutable = path.join(destination, asset.executable);
        // Settings select immutable version directories. Publish only after verification;
        // a failed/cancelled download never changes an instance's current executable.
        yield* Effect.gen(function* () {
          const record = path.join(staging, "installed.json");
          yield* fs.writeFileString(
            record,
            yield* encodeInstalled({
              version: asset.version,
              executable: selectedExecutable,
              sha256: asset.sha256,
            }),
          );
          yield* fs.rename(record, path.join(directory, "installed.json"));
          yield* activate(selectedExecutable).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                // Failed activation must not change the default for future instances.
                if (previous._tag === "Some") {
                  yield* fs.writeFileString(record, yield* encodeInstalled(previous.value));
                  yield* fs.rename(record, path.join(directory, "installed.json"));
                } else {
                  yield* fs.remove(path.join(directory, "installed.json"), { force: true });
                }
                return yield* Effect.fail(error);
              }),
            ),
          );
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            phase: "succeeded" as const,
            installedVersion: asset.version,
            message: "Installed.",
          }));
        }).pipe(Effect.uninterruptible);
      },
      Effect.scoped,
      Effect.timeout("45 minutes"),
    );

    const start = Effect.fn("ProviderCliInstallation.start")(function* (
      driver: CliInstallDriver,
      activate: (executable: string) => Effect.Effect<void, ProviderSetupError>,
    ) {
      const item = entry(driver);
      return yield* item.gate.withPermit(
        item.operation.start(install(driver, activate), "Finding the official release."),
      );
    });
    const cancel = Effect.fn("ProviderCliInstallation.cancel")(function* (
      driver: CliInstallDriver,
      operationId: string,
    ) {
      const item = entry(driver);
      return yield* item.gate.withPermit(
        Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(item.state)).operationId !== operationId) {
            return yield* Effect.fail(
              new ProviderCliInstallError({
                detail: "This installation is no longer current. Refresh before cancelling.",
              }),
            );
          }
          return yield* item.operation.cancel(operationId);
        }),
      );
    });
    const remove = Effect.fn("ProviderCliInstallation.remove")(function* (
      driver: CliInstallDriver,
      deactivate: Effect.Effect<void, ProviderSetupError>,
    ) {
      const item = entry(driver);
      return yield* item.gate.withPermit(
        Effect.gen(function* () {
          if (isProviderInstallActive(yield* SubscriptionRef.get(item.state))) {
            return yield* Effect.fail(
              new ProviderCliInstallError({
                detail: "Cancel the installation before removing its runtime.",
              }),
            );
          }
          yield* deactivate;
          yield* fs.remove(path.join(root, driver), { recursive: true, force: true });
          yield* SubscriptionRef.update(item.state, (value) => ({
            ...value,
            phase: "idle" as const,
            operationId: null,
            installedVersion: null,
            downloadedBytes: 0,
            totalBytes: null,
            canRemove: false,
            message: null,
          }));
          return yield* SubscriptionRef.get(item.state);
        }).pipe(Effect.uninterruptible),
      );
    });
    return {
      start,
      cancel,
      remove,
      directory: (driver: CliInstallDriver) => path.join(root, driver),
      changes: (driver: CliInstallDriver) => SubscriptionRef.changes(entry(driver).state),
    };
  },
);

export class ProviderCliInstallation extends Context.Service<
  ProviderCliInstallation,
  Effect.Success<ReturnType<typeof makeProviderCliInstallation>>
>()("t3/provider/ProviderCliInstallation") {
  static readonly layer = Layer.effect(
    ProviderCliInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return yield* makeProviderCliInstallation({ baseDir: config.baseDir });
    }),
  );
}
