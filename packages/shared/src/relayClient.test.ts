import { sha256 } from "@noble/hashes/sha2";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

import * as RelayClient from "./relayClient.ts";

// The suite runs the linux code path against the real filesystem, checking
// POSIX exec bits that NTFS never reports; the win32 branch skips that check.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const layerHostRuntime = (env: Record<string, string> = {}) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.succeed(HostProcessArchitecture, "x64"),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

function makeHandle(exitCode = 0, output = "") {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(100),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(output)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const layerHttpClient = (bytes: Uint8Array) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
      ),
    ),
  );

const layerSpawner = (commands: Array<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        commands.push(ChildProcess.isStandardCommand(command) ? command.command : "piped-command");
        // The pinned Windows executable rejects --version but accepts the version subcommand.
        return makeHandle(
          ChildProcess.isStandardCommand(command) && command.args.includes("--version") ? 1 : 0,
          `cloudflared version ${RelayClient.CLOUDFLARED_VERSION} (built 2026-05-01-0000 UTC)`,
        );
      }),
    ),
  );

const pinnedBinary = `cloudflared version ${RelayClient.CLOUDFLARED_VERSION} (built 2026-05-01-0000 UTC)
`;

const forkAutomaticRepair = Effect.fn("test.forkAutomaticRepair")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const clock = yield* Clock.Clock;
  const deadlineStarted = yield* Deferred.make<void>();
  const fiber = yield* effect.pipe(
    Effect.provideService(Clock.Clock, {
      ...clock,
      sleep: (duration) =>
        Effect.suspend(() => {
          if (Duration.toMillis(duration) === 30_000) {
            queueMicrotask(() => Deferred.doneUnsafe(deadlineStarted, Effect.void));
          }
          return clock.sleep(duration);
        }).pipe(
          // TestClock registers sleep before suspending. Defer the signal until that
          // registration, without allowing a cooperative yield between the two.
          Effect.provideService(Scheduler.PreventSchedulerYield, true),
        ),
    }),
    Effect.forkChild,
  );
  yield* Deferred.await(deadlineStarted).pipe(Effect.timeout("10 seconds"), TestClock.withLive);
  return fiber;
});

const makeManagedFixture = Effect.fn("test.makeManagedFixture")(function* (
  options: {
    readonly clientScope?: Scope.Scope;
    readonly probeExitCode?: number;
    readonly responseBody?: string;
    readonly responseStatus?: number;
    readonly stallAt?: "response" | "body" | "validation";
    readonly validationExitCode?: number;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
  const managedDirectory = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64`;
  const managedPath = `${managedDirectory}/cloudflared`;
  yield* fileSystem.makeDirectory(managedDirectory, { recursive: true });
  const stallStarted = yield* Deferred.make<void>();
  const installCleanedUp = yield* Deferred.make<void>();
  let stallCleanedUp = false;
  const stall = Deferred.succeed(stallStarted, undefined).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(
      Effect.sync(() => {
        stallCleanedUp = true;
      }),
    ),
  );
  const requests: Array<string> = [];
  const locksDuringDownload: Array<boolean> = [];
  const commands: Array<ChildProcess.StandardCommand> = [];
  const warnings: Array<unknown> = [];
  const writeBinary = Effect.fn("test.writeBinary")(function* (file: string, content: string) {
    yield* fileSystem.writeFileString(file, content);
    yield* fileSystem.chmod(file, 0o755);
  });
  const manager = yield* RelayClient.makeCloudflaredRelayClient({
    baseDir,
    releaseAsset: {
      url: "https://example.test/cloudflared",
      sha256: Hex.encode(sha256(new TextEncoder().encode(pinnedBinary))),
      archive: "binary",
    },
  }).pipe(
    Effect.provideService(Scope.Scope, options.clientScope ?? (yield* Effect.scope)),
    Effect.provideService(FileSystem.FileSystem, {
      ...fileSystem,
      remove: (file, options) =>
        fileSystem
          .remove(file, options)
          .pipe(
            Effect.tap(() =>
              file === `${managedPath}.lock`
                ? Deferred.succeed(installCleanedUp, undefined)
                : Effect.void,
            ),
          ),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          locksDuringDownload.push(
            yield* fileSystem.exists(`${managedPath}.lock`).pipe(Effect.orDie),
          );
          if (options.stallAt === "response" && requests.length === 1) return yield* stall;
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(options.responseBody ?? pinnedBinary, {
              status: options.responseStatus ?? 200,
            }),
          );
          if (options.stallAt === "body" && requests.length === 1) {
            Object.defineProperty(response, "arrayBuffer", { value: stall });
          }
          return response;
        }),
      ),
    ),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipe");
          commands.push(command);
          expect(command.args).toEqual(["version"]);
          if (
            options.stallAt === "validation" &&
            command.command !== managedPath &&
            requests.length === 1
          ) {
            return yield* stall;
          }
          return makeHandle(
            command.command === managedPath
              ? (options.probeExitCode ?? 0)
              : (options.validationExitCode ?? 0),
            yield* fileSystem.readFileString(command.command),
          );
        }),
      ),
    ),
  );
  const captureWarnings = Logger.layer(
    [
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      }),
    ],
    { mergeWithExisting: false },
  );
  return {
    baseDir,
    commands,
    manager,
    stallStarted,
    installCleanedUp,
    stallCleanedUp: () => stallCleanedUp,
    managedPath,
    requests,
    locksDuringDownload,
    warnings,
    writeBinary,
    captureWarnings,
  };
});

const managedTestLayer = Layer.mergeAll(NodeServices.layer, layerHostRuntime());

describe("RelayClient", () => {
  it.effect.skipIf(windowsHost)(
    "shares healthy checks across repeated and concurrent preparations",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeManagedFixture();
        yield* fixture.writeBinary(fixture.managedPath, pinnedBinary);
        const results = yield* Effect.all(
          Array.from({ length: 5 }, () => fixture.manager.prepare),
          { concurrency: "unbounded" },
        );
        const first = yield* fixture.manager.prepare;
        expect(results).toEqual(Array.from({ length: 5 }, () => first));
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.requests).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  it.effect.skipIf(windowsHost)("shares failed repairs until the retry cooldown expires", () =>
    Effect.gen(function* () {
      const fixture = yield* makeManagedFixture({ responseStatus: 503 });
      yield* fixture.writeBinary(fixture.managedPath, "cloudflared version 2026.9.3");
      yield* Effect.gen(function* () {
        const results = yield* Effect.all(
          Array.from({ length: 5 }, () => fixture.manager.prepare),
          { concurrency: "unbounded" },
        );
        expect(results.every((result) => result.status === "available")).toBe(true);
        yield* fixture.manager.prepare;
        expect(fixture.commands).toHaveLength(2);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.warnings).toHaveLength(1);
        yield* TestClock.adjust("299 seconds");
        yield* fixture.manager.prepare;
        expect(fixture.requests).toHaveLength(1);
        yield* TestClock.adjust("1 second");
        yield* fixture.manager.prepare;
        expect(fixture.commands).toHaveLength(4);
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.warnings).toHaveLength(2);
      }).pipe(Effect.provide(fixture.captureWarnings));
    }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  it.effect.skipIf(windowsHost)(
    "explicit installation retries during the automatic repair cooldown",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeManagedFixture({ responseStatus: 503 });
        yield* fixture.writeBinary(fixture.managedPath, "cloudflared version 2026.9.3");
        yield* fixture.manager.prepare.pipe(Effect.provide(fixture.captureWarnings));
        const error = yield* fixture.manager.install.pipe(Effect.flip);
        expect(error.reason).toBe("download_failed");
        expect(fixture.requests).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  it.effect.skipIf(windowsHost)("rechecks a replaced file even when its size and mtime match", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeManagedFixture();
      yield* fixture.writeBinary(fixture.managedPath, pinnedBinary);
      yield* fixture.manager.prepare;
      const info = yield* fileSystem.stat(fixture.managedPath);
      const replacement = `${fixture.managedPath}.replacement`;
      yield* fixture.writeBinary(replacement, pinnedBinary.replace("2026.5.2", "2026.9.3"));
      if (info.mtime._tag === "Some")
        yield* fileSystem.utimes(replacement, info.mtime.value, info.mtime.value);
      yield* fileSystem.rename(replacement, fixture.managedPath);
      yield* fixture.manager.prepare;
      expect(fixture.requests).toHaveLength(1);
      expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(pinnedBinary);
    }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  it.effect.skipIf(windowsHost)(
    "invalidates a failed repair when the executable changes in place",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeManagedFixture({ responseStatus: 503 });
        yield* fixture.writeBinary(fixture.managedPath, "cloudflared version 2026.9.3");
        yield* fixture.manager.prepare.pipe(Effect.provide(fixture.captureWarnings));
        yield* fixture.writeBinary(fixture.managedPath, pinnedBinary);
        yield* fixture.manager.prepare;
        yield* fixture.manager.prepare;
        expect(fixture.commands).toHaveLength(3);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.warnings).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  it.effect.skipIf(windowsHost)(
    "invalidates the managed check when selection switches to an override",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeManagedFixture();
        yield* fixture.writeBinary(fixture.managedPath, pinnedBinary);
        yield* fixture.manager.prepare;
        const overridePath = `${fixture.baseDir}/override`;
        yield* fixture.writeBinary(overridePath, "user-selected version");
        expect(
          yield* fixture.manager.prepare.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({ env: { T3CODE_CLOUDFLARED_PATH: overridePath } }),
            ),
          ),
        ).toMatchObject({ source: "override" });
        yield* fixture.manager.prepare;
        expect(fixture.commands).toHaveLength(2);
        expect(fixture.requests).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  it.effect.skipIf(windowsHost)("inspects a stale managed binary without repairing it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeManagedFixture();
      const oldBinary = "cloudflared version 2026.9.3";
      yield* fixture.writeBinary(fixture.managedPath, oldBinary);
      expect(yield* fixture.manager.resolve).toMatchObject({
        status: "available",
        source: "managed",
        executablePath: fixture.managedPath,
      });
      expect(fixture.commands).toEqual([]);
      expect(fixture.requests).toEqual([]);
      expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(oldBinary);
    }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  for (const stallAt of ["response", "body", "validation"] as const) {
    it.effect.skipIf(windowsHost)(
      `falls back and cleans up a stalled ${stallAt} within 30 seconds`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const fixture = yield* makeManagedFixture({ stallAt });
          const oldBinary = "cloudflared version 2026.9.3";
          yield* fixture.writeBinary(fixture.managedPath, oldBinary);
          const resolving = yield* fixture.manager.prepare.pipe(
            Effect.provide(fixture.captureWarnings),
            forkAutomaticRepair,
          );
          yield* Deferred.await(fixture.stallStarted);
          yield* TestClock.adjust("30 seconds");
          const result = yield* Fiber.join(resolving).pipe(
            Effect.timeout("10 seconds"),
            TestClock.withLive,
          );
          expect(result).toMatchObject({
            status: "available",
            source: "managed",
            executablePath: fixture.managedPath,
          });
          expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(oldBinary);
          expect((yield* fileSystem.stat(fixture.managedPath)).mode & 0o111).not.toBe(0);
          yield* Deferred.await(fixture.installCleanedUp).pipe(
            Effect.timeout("10 seconds"),
            TestClock.withLive,
          );
          expect(fixture.stallCleanedUp()).toBe(true);
          expect(
            yield* fileSystem.readDirectory(
              fixture.managedPath.slice(0, fixture.managedPath.lastIndexOf("/")),
            ),
          ).toEqual(["cloudflared"]);
          expect(fixture.warnings).toHaveLength(1);
          // A subsequent explicit install proves the semaphore and lock were released.
          yield* fixture.manager.install;
          expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(pinnedBinary);
        }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
    );
  }

  for (const invalidation of ["cooldown expiry", "file change"] as const) {
    it.effect.skipIf(windowsHost)(
      `cools down timeouts behind an explicit install until ${invalidation}`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const fixture = yield* makeManagedFixture({ stallAt: "response" });
          const oldBinary = "cloudflared version 2026.9.3";
          yield* fixture.writeBinary(fixture.managedPath, oldBinary);
          const installing = yield* fixture.manager.install.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.stallStarted);
          const resolving = yield* fixture.manager.prepare.pipe(
            Effect.provide(fixture.captureWarnings),
            forkAutomaticRepair,
          );
          const concurrentResolving = yield* fixture.manager.prepare.pipe(
            Effect.provide(fixture.captureWarnings),
            forkAutomaticRepair,
          );
          yield* TestClock.adjust("29 seconds");
          expect(resolving.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 second");
          expect(
            yield* Fiber.join(resolving).pipe(Effect.timeout("10 seconds"), TestClock.withLive),
          ).toMatchObject({
            status: "available",
            source: "managed",
            executablePath: fixture.managedPath,
          });
          yield* Fiber.join(concurrentResolving).pipe(
            Effect.timeout("10 seconds"),
            TestClock.withLive,
          );
          // Join without advancing TestClock: cached preparation must not wait for the permit.
          const cached = yield* fixture.manager.prepare.pipe(
            Effect.provide(fixture.captureWarnings),
            Effect.forkChild,
          );
          expect(
            yield* Fiber.join(cached).pipe(Effect.timeout("10 seconds"), TestClock.withLive),
          ).toMatchObject({ source: "managed", executablePath: fixture.managedPath });
          expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(oldBinary);
          expect(fixture.warnings).toEqual([
            [
              expect.stringContaining("Keeping the existing binary"),
              expect.objectContaining({ reason: "repair_timeout" }),
            ],
          ]);
          expect(installing.pollUnsafe()).toBeUndefined();
          expect(fixture.stallCleanedUp()).toBe(false);
          expect(yield* fileSystem.exists(`${fixture.managedPath}.lock`)).toBe(true);
          expect(fixture.requests).toHaveLength(1);
          expect(fixture.commands).toHaveLength(2);
          if (invalidation === "cooldown expiry") {
            yield* TestClock.adjust("299 seconds");
            const stillCached = yield* fixture.manager.prepare.pipe(
              Effect.provide(fixture.captureWarnings),
              Effect.forkChild,
            );
            expect(
              yield* Fiber.join(stillCached).pipe(Effect.timeout("10 seconds"), TestClock.withLive),
            ).toMatchObject({ source: "managed" });
            expect(fixture.warnings).toHaveLength(1);
            yield* TestClock.adjust("1 second");
          } else {
            yield* fixture.writeBinary(fixture.managedPath, `${oldBinary}\nchanged`);
          }
          const retrying = yield* fixture.manager.prepare.pipe(
            Effect.provide(fixture.captureWarnings),
            forkAutomaticRepair,
          );
          yield* TestClock.adjust("29 seconds");
          expect(retrying.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 second");
          expect(
            yield* Fiber.join(retrying).pipe(Effect.timeout("10 seconds"), TestClock.withLive),
          ).toMatchObject({ source: "managed", executablePath: fixture.managedPath });
          expect(fixture.warnings).toHaveLength(2);
          expect(installing.pollUnsafe()).toBeUndefined();
          expect(fixture.stallCleanedUp()).toBe(false);
          expect(yield* fileSystem.exists(`${fixture.managedPath}.lock`)).toBe(true);
          expect(fixture.requests).toHaveLength(1);
          expect(fixture.commands).toHaveLength(2);
          // Only the test owner interrupts the explicit installer, after proving fallback.
          yield* Fiber.interrupt(installing);
          yield* fixture.manager.install;
          expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(pinnedBinary);
        }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
    );
  }

  for (const source of ["override", "path", "missing"] as const) {
    it.effect.skipIf(windowsHost)(
      `resolves ${source} without waiting for an explicit install`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeManagedFixture({ stallAt: "response" });
          const installing = yield* fixture.manager.install.pipe(Effect.forkChild);
          yield* Deferred.await(fixture.stallStarted);
          const executablePath = `${fixture.baseDir}/cloudflared`;
          if (source !== "missing")
            yield* fixture.writeBinary(executablePath, "user-selected version");
          const env =
            source === "override"
              ? { T3CODE_CLOUDFLARED_PATH: executablePath, PATH: "" }
              : { PATH: fixture.baseDir };
          const result = yield* fixture.manager.prepare.pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
            Effect.timeout("10 seconds"),
            TestClock.withLive,
          );
          expect(result).toMatchObject(
            source === "missing"
              ? { status: "missing" }
              : { status: "available", source, executablePath },
          );
          expect(installing.pollUnsafe()).toBeUndefined();
          expect(fixture.stallCleanedUp()).toBe(false);
          expect(fixture.commands).toEqual([]);
          expect(fixture.requests).toHaveLength(1);
          yield* Fiber.interrupt(installing);
        }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
    );
  }

  for (const phase of ["staging", "activation"] as const) {
    it.effect.skipIf(windowsHost)(`falls back before the stalled ${phase} rename completes`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const renameStarted = yield* Deferred.make<void>();
        const finishRename = yield* Deferred.make<void>();
        const fixture = yield* makeManagedFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            rename: (from, to) =>
              Effect.gen(function* () {
                yield* fileSystem.rename(from, to);
                if ((phase === "staging" ? to : from).endsWith(".tmp")) {
                  // Model a completed filesystem side effect whose callback has not arrived.
                  yield* Deferred.succeed(renameStarted, undefined);
                  yield* Deferred.await(finishRename);
                }
              }),
          }),
        );
        const oldBinary = "cloudflared version 2026.9.3";
        yield* fixture.writeBinary(fixture.managedPath, oldBinary);
        const resolving = yield* fixture.manager.prepare.pipe(
          Effect.provide(fixture.captureWarnings),
          forkAutomaticRepair,
        );
        yield* Effect.gen(function* () {
          yield* Deferred.await(renameStarted);
          yield* TestClock.adjust("30 seconds");
          expect(
            yield* Fiber.join(resolving).pipe(Effect.timeout("10 seconds"), TestClock.withLive),
          ).toMatchObject({ status: "available", executablePath: fixture.managedPath });
          const cached = yield* fixture.manager.prepare.pipe(
            Effect.provide(fixture.captureWarnings),
            Effect.forkChild,
          );
          expect(
            yield* Fiber.join(cached).pipe(Effect.timeout("10 seconds"), TestClock.withLive),
          ).toMatchObject({ status: "available", executablePath: fixture.managedPath });
          expect(fixture.requests).toHaveLength(1);
          expect(yield* fileSystem.exists(`${fixture.managedPath}.lock`)).toBe(true);
          expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(
            phase === "staging" ? oldBinary : pinnedBinary,
          );
        }).pipe(Effect.ensuring(Deferred.succeed(finishRename, undefined)));
        expect(
          yield* Fiber.join(resolving).pipe(Effect.timeout("10 seconds"), TestClock.withLive),
        ).toMatchObject({ status: "available", executablePath: fixture.managedPath });
        yield* fixture.manager.install.pipe(Effect.timeout("10 seconds"), TestClock.withLive);
        expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(pinnedBinary);
        expect((yield* fileSystem.stat(fixture.managedPath)).mode & 0o111).not.toBe(0);
        expect(
          yield* fileSystem.readDirectory(
            fixture.managedPath.slice(0, fixture.managedPath.lastIndexOf("/")),
          ),
        ).toEqual(["cloudflared"]);
        expect(fixture.warnings).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
    );
  }

  it.effect.skipIf(windowsHost)("owns a timed-out activation until the client scope closes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const clientScope = yield* Scope.make();
      const renameStarted = yield* Deferred.make<void>();
      const finishRename = yield* Deferred.make<void>();
      const scopeClosing = yield* Deferred.make<void>();
      const fixture = yield* makeManagedFixture({ clientScope }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (from.endsWith(".tmp")) {
                yield* Deferred.succeed(renameStarted, undefined);
                yield* Deferred.await(finishRename);
              }
              yield* fileSystem.rename(from, to);
            }),
        }),
      );
      yield* fixture.writeBinary(fixture.managedPath, "cloudflared version 2026.9.3");
      yield* Effect.gen(function* () {
        const preparing = yield* fixture.manager.prepare.pipe(
          Effect.provide(fixture.captureWarnings),
          forkAutomaticRepair,
        );
        yield* Deferred.await(renameStarted);
        yield* TestClock.adjust("30 seconds");
        yield* Fiber.join(preparing).pipe(Effect.timeout("10 seconds"), TestClock.withLive);
        yield* Scope.addFinalizer(clientScope, Deferred.succeed(scopeClosing, undefined));
        const closing = yield* Scope.close(clientScope, Exit.void).pipe(Effect.forkChild);
        yield* Deferred.await(scopeClosing);
        expect(closing.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(finishRename, undefined);
        yield* Fiber.join(closing).pipe(Effect.timeout("10 seconds"), TestClock.withLive);
        expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(pinnedBinary);
        expect(
          yield* fileSystem.readDirectory(
            fixture.managedPath.slice(0, fixture.managedPath.lastIndexOf("/")),
          ),
        ).toEqual(["cloudflared"]);
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(finishRename, undefined).pipe(
            Effect.andThen(Scope.close(clientScope, Exit.void)),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  for (const version of ["2026.9.3", "2026.8.2", "2026.5.20"]) {
    it.effect.skipIf(windowsHost)(`repairs a managed ${version} binary before preparing it`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const fixture = yield* makeManagedFixture();
        yield* fixture.writeBinary(
          fixture.managedPath,
          `cloudflared version ${version} (built yesterday)`,
        );
        const resolved = yield* fixture.manager.prepare;
        expect(resolved).toMatchObject({
          status: "available",
          source: "managed",
          executablePath: fixture.managedPath,
        });
        expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(pinnedBinary);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.locksDuringDownload).toEqual([true]);
        expect(yield* fileSystem.exists(`${fixture.managedPath}.lock`)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
    );
  }

  it.effect.skipIf(windowsHost)("uses a matching managed binary without downloading", () =>
    Effect.gen(function* () {
      const fixture = yield* makeManagedFixture();
      yield* fixture.writeBinary(fixture.managedPath, pinnedBinary);
      expect(yield* fixture.manager.prepare).toMatchObject({
        status: "available",
        source: "managed",
      });
      expect(fixture.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  for (const failure of [
    { name: "download failure", responseStatus: 503, reason: "download_failed" },
    { name: "checksum mismatch", responseBody: "tampered", reason: "invalid_checksum" },
    { name: "validation failure", validationExitCode: 1, reason: "validation_failed" },
  ]) {
    it.effect.skipIf(windowsHost)(
      `keeps the existing managed binary and warns after a ${failure.name}`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const fixture = yield* makeManagedFixture(failure);
          const staleBinary = "cloudflared version 2026.9.3";
          yield* fixture.writeBinary(fixture.managedPath, staleBinary);
          const resolved = yield* fixture.manager.prepare.pipe(
            Effect.provide(fixture.captureWarnings),
          );
          expect(resolved).toMatchObject({
            status: "available",
            source: "managed",
            executablePath: fixture.managedPath,
          });
          expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(staleBinary);
          expect(fixture.requests).toHaveLength(1);
          expect(fixture.locksDuringDownload).toEqual([true]);
          expect(fixture.warnings).toEqual([
            [
              expect.stringContaining("Keeping the existing binary"),
              expect.objectContaining({ reason: failure.reason }),
            ],
          ]);
          expect(yield* fileSystem.exists(`${fixture.managedPath}.lock`)).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
    );
  }

  for (const probe of [
    { name: "unrecognized version output", output: "unknown" },
    { name: "an unsuccessful version command", output: pinnedBinary, probeExitCode: 1 },
  ]) {
    it.effect.skipIf(windowsHost)(`repairs a managed binary with ${probe.name}`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const fixture = yield* makeManagedFixture(probe);
        yield* fixture.writeBinary(fixture.managedPath, probe.output);
        expect(yield* fixture.manager.prepare).toMatchObject({ source: "managed" });
        expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(pinnedBinary);
        expect(fixture.requests).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
    );
  }

  it.effect.skipIf(windowsHost)(
    "serializes concurrent repairs before resolving the managed binary",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeManagedFixture();
        yield* fixture.writeBinary(fixture.managedPath, "cloudflared version 2026.9.3");
        const [first, second] = yield* Effect.all(
          [fixture.manager.prepare, fixture.manager.prepare],
          {
            concurrency: "unbounded",
          },
        );
        expect(first).toMatchObject({ status: "available", source: "managed" });
        expect(second).toEqual(first);
        expect(fixture.requests).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  for (const source of ["override", "path"] as const) {
    it.effect.skipIf(windowsHost)(`does not validate or replace a ${source} binary`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const fixture = yield* makeManagedFixture();
        const executablePath = `${fixture.baseDir}/cloudflared`;
        yield* fixture.writeBinary(executablePath, "user-selected version");
        if (source === "override") {
          yield* fixture.writeBinary(fixture.managedPath, "cloudflared version 2026.9.3");
        }
        const env =
          source === "override"
            ? { T3CODE_CLOUDFLARED_PATH: executablePath, PATH: "" }
            : { PATH: fixture.baseDir };
        yield* Effect.gen(function* () {
          expect(yield* fixture.manager.prepare).toMatchObject({ source, executablePath });
          expect(yield* fixture.manager.install).toMatchObject({ source, executablePath });
        }).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
        );
        expect(yield* fileSystem.readFileString(executablePath)).toBe("user-selected version");
        expect(fixture.commands).toEqual([]);
        expect(fixture.requests).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
    );
  }

  it.effect.skipIf(windowsHost)("rechecks the managed version under the installation lock", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeManagedFixture();
      yield* fixture.writeBinary(fixture.managedPath, "cloudflared version 2026.9.3");
      const installed = yield* fixture.manager.installWithProgress((event) =>
        event.type === "progress" && event.stage === "waiting_for_lock"
          ? fixture.writeBinary(fixture.managedPath, pinnedBinary).pipe(Effect.orDie)
          : Effect.void,
      );
      expect(installed).toMatchObject({ source: "managed" });
      expect(yield* fileSystem.readFileString(fixture.managedPath)).toBe(pinnedBinary);
      expect(fixture.requests).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(managedTestLayer)),
  );

  it.effect.skipIf(windowsHost)(
    "resolves explicit overrides before managed and PATH executables",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const overridePath = `${baseDir}/override-cloudflared`;
        yield* fileSystem.writeFileString(overridePath, "override");
        yield* fileSystem.chmod(overridePath, 0o755);
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
        });

        expect(
          yield* manager.resolve.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({
                env: { PATH: "", T3CODE_CLOUDFLARED_PATH: overridePath },
              }),
            ),
          ),
        ).toEqual({
          status: "available",
          executablePath: overridePath,
          source: "override",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new Uint8Array()),
            layerSpawner([]),
            layerHostRuntime(),
          ),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)(
    "downloads, verifies, validates, and atomically installs the managed executable",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const bytes = new TextEncoder().encode("test-cloudflared-binary");
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
          releaseAsset: {
            url: "https://example.test/cloudflared",
            sha256: Hex.encode(sha256(bytes)),
            archive: "binary",
          },
        });

        const progress: Array<string> = [];
        const installed = yield* manager.installWithProgress((event) =>
          Effect.sync(() => {
            if (event.type === "progress") {
              progress.push(event.stage);
            }
          }),
        );
        const managedPath = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64/cloudflared`;
        expect(installed).toEqual({
          status: "available",
          executablePath: managedPath,
          source: "managed",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
        expect(new TextDecoder().decode(yield* fileSystem.readFile(managedPath))).toBe(
          "test-cloudflared-binary",
        );
        expect(progress).toEqual([
          "checking",
          "waiting_for_lock",
          "downloading",
          "verifying",
          "installing",
          "validating",
          "activating",
        ]);
        expect(yield* manager.resolve).toEqual(installed);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new TextEncoder().encode("test-cloudflared-binary")),
            layerSpawner([]),
            layerHostRuntime(),
          ),
        ),
      ),
  );

  it.effect("rejects downloads whose checksum does not match the pinned manifest", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(new TextEncoder().encode("expected"))),
          archive: "binary",
        },
      });

      const error = yield* manager.install.pipe(Effect.flip);
      expect(error).toBeInstanceOf(RelayClient.RelayClientInstallError);
      expect(error.reason).toBe("invalid_checksum");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(new TextEncoder().encode("tampered")),
          layerSpawner([]),
          layerHostRuntime(),
        ),
      ),
    ),
  );

  it.effect.skipIf(windowsHost)("serializes concurrent installs within one runtime", () => {
    const commands: Array<string> = [];
    const bytes = new TextEncoder().encode("test-cloudflared-binary");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-cloudflared-test-",
      });
      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(bytes)),
          archive: "binary",
        },
      });

      const [first, second] = yield* Effect.all([manager.install, manager.install], {
        concurrency: "unbounded",
      });
      expect(second).toEqual(first);
      expect(commands.filter((command) => command.includes(".install-"))).toHaveLength(1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          layerHttpClient(bytes),
          layerSpawner(commands),
          layerHostRuntime(),
        ),
      ),
    );
  });

  it.effect.skipIf(windowsHost)(
    "observes PATH changes after the manager has been constructed",
    () => {
      const env = { PATH: "" };
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cloudflared-test-",
        });
        const binDir = `${baseDir}/bin`;
        const executablePath = `${binDir}/cloudflared`;
        const manager = yield* RelayClient.makeCloudflaredRelayClient({
          baseDir,
        });

        expect(yield* manager.resolve).toEqual({
          status: "missing",
          version: RelayClient.CLOUDFLARED_VERSION,
        });

        yield* fileSystem.makeDirectory(binDir);
        yield* fileSystem.writeFileString(executablePath, "cloudflared");
        yield* fileSystem.chmod(executablePath, 0o755);
        env.PATH = binDir;

        expect(yield* manager.resolve).toEqual({
          status: "available",
          executablePath,
          source: "path",
          version: RelayClient.CLOUDFLARED_VERSION,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            layerHttpClient(new Uint8Array()),
            layerSpawner([]),
            layerHostRuntime(env),
          ),
        ),
      );
    },
  );
});
