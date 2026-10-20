import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
  type PinnedRuntimeProgress,
  prunePinnedRuntimes,
} from "./pinnedRuntime.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const version = "1.2.3";
const archiveName = `t3-${version}-linux-x64.tar.gz`;
const archiveBytes = new TextEncoder().encode("not really a tarball");
const archiveHex = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
const validChecksums = archiveHex(archiveBytes).pipe(
  Effect.map((hex) => `${hex}  ${archiveName}\n`),
);
const releaseHttpClient = (checksums: string, requests: string[] = []) =>
  HttpClient.make((request) => {
    requests.push(request.url);
    const body = request.url.endsWith("/SHA256SUMS") ? checksums : archiveBytes;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
  });
const extractingRunner = (fs: FileSystem.FileSystem, path: Path.Path, commands: string[] = []) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input.command);
        const targetIndex = input.args.indexOf("-C");
        const stagingDir = input.args[targetIndex + 1];
        if (input.command !== "tar" || stagingDir === undefined) {
          return yield* Effect.die(`unexpected command ${input.command}`);
        }
        yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("installs the verified release archive as the runtime executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-" });
      const requests: string[] = [];
      const commands: string[] = [];
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        releaseBaseUrl: "https://releases.example/download",
        runner: extractingRunner(fs, path, commands),
        validate: (staging) =>
          fs.exists(staging.entryPath).pipe(
            Effect.flatMap((exists) => (exists ? Effect.void : Effect.die("missing runtime"))),
            Effect.orDie,
          ),
      });
      assert.equal(paths.entryPath, path.join(paths.versionDir, "t3"));
      assert.deepEqual(pinnedRuntimeCommand(paths), { command: paths.entryPath, args: [] });
      assert.deepEqual(requests, [
        `https://releases.example/download/v${version}/SHA256SUMS`,
        `https://releases.example/download/v${version}/${archiveName}`,
      ]);
      assert.deepEqual(commands, ["tar"]);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
      assert.isFalse(yield* fs.exists(path.join(paths.versionDir, "t3-runtime-archive")));
    }),
  );

  it.effect.each([true, false])(
    "reports bytes before completion, then verifies and extracts (known size: %s)",
    (knownSize) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-" });
        const firstChunk = yield* Deferred.make<void>();
        let archiveController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const checksums = yield* validChecksums;
        const progress: PinnedRuntimeProgress[] = [];
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.endsWith("/SHA256SUMS")
                ? new Response(checksums)
                : new Response(
                    new ReadableStream({
                      start(controller) {
                        archiveController = controller;
                        controller.enqueue(archiveBytes.slice(0, 4));
                      },
                    }),
                    { headers: knownSize ? { "content-length": String(archiveBytes.length) } : {} },
                  ),
            ),
          ),
        );
        const install = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: client,
          runner: extractingRunner(fs, path),
          validate: () => Effect.void,
          onProgress: (event) => {
            progress.push(event);
            if (event.stage === "download" && event.received === 4) {
              Deferred.doneUnsafe(firstChunk, Effect.void);
            }
          },
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(firstChunk);
        assert.deepEqual(progress.at(-1), {
          stage: "download",
          received: 4,
          total: knownSize ? archiveBytes.length : undefined,
        });
        assert.isFalse(progress.some((event) => event.stage === "extract"));
        assert.isDefined(archiveController);
        archiveController!.enqueue(archiveBytes.slice(4));
        archiveController!.close();
        const installed = yield* Fiber.join(install);
        assert.deepEqual(progress.slice(-4), [
          { stage: "download", received: archiveBytes.length, total: archiveBytes.length },
          { stage: "verify" },
          { stage: "extract" },
          { stage: "validate" },
        ]);
        assert.equal(yield* fs.readFileString(installed.sentinelPath), `${version}\n`);
      }),
  );

  it.effect("cleans up an interrupted download without reporting verification or extraction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-failed-" });
      const checksums = yield* validChecksums;
      const progress: PinnedRuntimeProgress[] = [];
      let cancelled = false;
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/SHA256SUMS")
              ? new Response(checksums)
              : new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(archiveBytes.slice(0, 4));
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                ),
          ),
        ),
      );
      const firstChunk = yield* Deferred.make<void>();
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: client,
        runner: extractingRunner(fs, path),
        validate: () => Effect.die("must not validate an interrupted archive"),
        onProgress: (event) => {
          progress.push(event);
          if (event.stage === "download" && event.received === 4)
            Deferred.doneUnsafe(firstChunk, Effect.void);
        },
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstChunk);
      yield* Fiber.interrupt(install);
      assert.deepEqual(progress.at(-1), { stage: "download", received: 4, total: undefined });
      assert.isTrue(progress.every((event) => event.stage === "download"));
      assert.isTrue(cancelled);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect.each([true, false])(
    "installs a download receiving bytes for over ten minutes (progress: %s)",
    (reportProgress) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-slow-" });
        const checksums = yield* validChecksums;
        const reads = yield* Effect.forEach(archiveBytes, () => Deferred.make<void>());
        let controller: ReadableStreamDefaultController<Uint8Array>;
        let offset = 0;
        const body = new ReadableStream<Uint8Array>(
          {
            start(value) {
              controller = value;
            },
            pull() {
              Deferred.doneUnsafe(reads[offset++]!, Effect.void);
            },
          },
          { highWaterMark: 0 },
        );
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(request.url.endsWith("/SHA256SUMS") ? checksums : body),
            ),
          ),
        );
        const progress: PinnedRuntimeProgress[] = [];
        yield* Effect.gen(function* () {
          // Each read is demanded by the consumer, with no prefetched chunks.
          for (let index = 0; index < archiveBytes.length; index++) {
            yield* Deferred.await(reads[index]!);
            yield* TestClock.adjust(Duration.seconds(40));
            controller.enqueue(archiveBytes.slice(index, index + 1));
          }
          controller.close();
        }).pipe(Effect.forkScoped);
        const installed = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: client,
          runner: extractingRunner(fs, path),
          validate: () => Effect.void,
          ...(reportProgress
            ? { onProgress: (event: PinnedRuntimeProgress) => progress.push(event) }
            : {}),
        });
        assert.equal(yield* fs.readFileString(installed.sentinelPath), `${version}\n`);
        if (reportProgress) {
          assert.deepEqual(progress.slice(-4), [
            { stage: "download", received: archiveBytes.length, total: archiveBytes.length },
            { stage: "verify" },
            { stage: "extract" },
            { stage: "validate" },
          ]);
        }
      }),
  );

  it.effect.each([
    { stall: "response", reportProgress: false },
    { stall: "body", reportProgress: false },
    { stall: "body", reportProgress: true },
  ])(
    "fails a one-minute $stall stall, cleans up and releases the lock (progress: $reportProgress)",
    ({ stall, reportProgress }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-stalled-" });
        const checksums = yield* validChecksums;
        const waiting = yield* Deferred.make<void>();
        let cancelled = false;
        let sentChunk = false;
        const client = HttpClient.make((request) => {
          if (request.url.endsWith("/SHA256SUMS")) {
            return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(checksums)));
          }
          if (stall === "response") {
            return Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cancelled = true;
                }),
              ),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      if (!sentChunk) {
                        sentChunk = true;
                        controller.enqueue(archiveBytes.slice(0, 4));
                      } else {
                        Deferred.doneUnsafe(waiting, Effect.void);
                      }
                    },
                    cancel() {
                      cancelled = true;
                    },
                  },
                  { highWaterMark: 0 },
                ),
              ),
            ),
          );
        });
        const progress: PinnedRuntimeProgress[] = [];
        const commands: string[] = [];
        const install = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: client,
          runner: extractingRunner(fs, path, commands),
          validate: () => Effect.die("must not validate a stalled archive"),
          ...(reportProgress
            ? { onProgress: (event: PinnedRuntimeProgress) => progress.push(event) }
            : {}),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust(Duration.minutes(1));
        assert.isTrue(cancelled, "the stalled transfer must be cancelled after one minute");
        const error = yield* Fiber.join(install).pipe(Effect.flip);
        assert.instanceOf(error, PinnedRuntimeInstallError);
        assert.equal(error.step, "downloading the t3 release archive (timed out)");
        assert.deepEqual(commands, []);
        assert.isTrue(progress.every((event) => event.stage === "download"));
        assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
        const installed = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(checksums),
          runner: extractingRunner(fs, path),
          validate: () => Effect.void,
        });
        assert.equal(yield* fs.readFileString(installed.sentinelPath), `${version}\n`);
      }),
  );

  it.effect("refuses an archive whose checksum does not match the release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-bad-" });
      const commands: string[] = [];
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(`${"0".repeat(64)}  ${archiveName}\n`),
        runner: extractingRunner(fs, path, commands),
        validate: () => Effect.die("must not validate an unverified archive"),
      }).pipe(Effect.flip);
      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.equal(error.step, "verifying the t3 release archive checksum");
      assert.deepEqual(commands, []);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), `${version}\n`);
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("replaces an incomplete pinned runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () => Effect.void,
      });

      assert.isFalse(yield* fs.exists(path.join(finalPaths.versionDir, "partial")));
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(finalPaths.sentinelPath, `${version}\n`);

      let validations = 0;
      const requests: string[] = [];
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        runner: extractingRunner(fs, path),
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.deepEqual(requests, []);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );

  it.effect("removes staging when installation is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-interrupt-" });
      const started = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner,
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      const versionsDir = path.join(baseDir, "runtime", "versions");
      assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
    }),
  );
});

it.layer(NodeServices.layer)("prunePinnedRuntimes", (it) => {
  const lsofRunner = (stdout: string) =>
    ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed({
          stdout,
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    });

  const setup = Effect.fn(function* (versions: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-prune-" });
    const versionsDir = path.join(baseDir, "runtime", "versions");
    const now = Duration.toMillis(Duration.days(1));
    yield* TestClock.setTime(now);
    const install = Effect.fn(function* (
      version: string,
      completed: "long ago" | "just now" | "never" = "long ago",
    ) {
      const directory = path.join(versionsDir, version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "t3"), "");
      if (completed === "never") return;
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      const at = completed === "just now" ? now : 0;
      yield* fs.utimes(sentinel, at, at);
    });
    for (const version of versions) yield* install(version);
    return { baseDir, versionsDir, install };
  });

  it.effect("removes only completed runtimes nothing references", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir, install } = yield* setup([
        "1.0.0",
        "1.1.0",
        "1.2.0",
        "1.2.5",
        "1.3.0",
        "1.3.5",
        "1.4.0",
        "1.5.0",
        "2.0.0",
        "2.1.0",
      ]);
      // A downgrade another process installed but has not pointed anything at yet.
      yield* install("0.5.0", "just now");
      yield* install("1.0.1", "never");
      yield* install(".staging-abc", "never");
      yield* install(".pruned-0.8.0");
      yield* install("other", "never");
      yield* fs.symlink(path.join(versionsDir, "other"), path.join(versionsDir, "0.9.0"));
      const binDir = path.join(baseDir, "bin");
      const customBinDir = path.join(baseDir, "custom-bin");
      yield* fs.makeDirectory(binDir);
      yield* fs.makeDirectory(customBinDir);
      // Chained: the launcher reaches its runtime through a second link.
      yield* fs.symlink(path.join(versionsDir, "1.2.0", "t3"), path.join(baseDir, "alias-t3"));
      yield* fs.symlink(path.join(baseDir, "alias-t3"), path.join(binDir, "t3"));
      yield* fs.symlink(path.join(versionsDir, "1.2.5", "t3"), path.join(customBinDir, "t3"));
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "launchers"),
        `${path.join(customBinDir, "t3")}\n`,
      );
      yield* fs.writeFileString(
        path.join(baseDir, "runtime", "service-state.json"),
        JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.4.0",
          update: { id: "u", fromVersion: "1.4.0", targetVersion: "1.5.0", status: "rolled-back" },
        }),
      );

      const removed = yield* prunePinnedRuntimes({
        baseDir,
        keep: ["2.0.0"],
        references: [`ExecStart=${path.join(versionsDir, "1.3.5", "t3")} __service-launcher`],
      }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          lsofRunner(`p42\nftxt\nn${path.join(versionsDir, "1.3.0", "t3")}\n`),
        ),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: binDir }),
      );

      // 1.2.0 is the default launcher, 1.2.5 a recorded one, 1.3.0 running, 1.3.5 in the unit,
      // 1.4.0 active, 1.5.0 the rolled-back target, 2.0.0 the caller's, 0.5.0 just installed.
      // Being newer than the caller's version does not keep 2.1.0.
      assert.deepEqual(removed.toSorted(), ["0.8.0", "1.0.0", "1.1.0", "2.1.0"]);
      // The launcher found on PATH is remembered for a service that cannot see it.
      assert.equal(
        yield* fs.readFileString(path.join(baseDir, "runtime", "launchers")),
        `${path.join(customBinDir, "t3")}\n${path.join(binDir, "t3")}\n`,
      );
      assert.deepEqual((yield* fs.readDirectory(versionsDir)).toSorted(), [
        ".staging-abc",
        "0.5.0",
        "0.9.0",
        "1.0.1",
        "1.2.0",
        "1.2.5",
        "1.3.0",
        "1.3.5",
        "1.4.0",
        "1.5.0",
        "2.0.0",
        "other",
      ]);
    }),
  );

  it.effect("matches a Windows shim whatever its casing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
      const shim = path.join(baseDir, "t3.cmd");
      yield* fs.writeFileString(
        shim,
        `@echo off\r\n"${path.join(versionsDir, "1.0.0", "t3.exe").toUpperCase()}" %*`,
      );
      yield* fs.writeFileString(path.join(baseDir, "runtime", "launchers"), `${shim}\n`);

      const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          lsofRunner("C:\\Windows\\explorer.exe\n"),
        ),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      assert.deepEqual(removed, ["1.1.0"]);
    }),
  );

  it.effect.each([
    { name: "the process list is unavailable", state: undefined, lsof: "" },
    { name: "the service state is unparseable", state: "{", lsof: "p1\nftxt\nn/sbin/launchd\n" },
    {
      name: "the service state cannot be read",
      state: null,
      lsof: "p1\nftxt\nn/sbin/launchd\n",
    },
  ])("keeps everything when $name", ({ state, lsof }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, versionsDir } = yield* setup(["1.0.0"]);
      const statePath = path.join(baseDir, "runtime", "service-state.json");
      if (state === null) yield* fs.makeDirectory(statePath);
      else if (state !== undefined) yield* fs.writeFileString(statePath, state);

      const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, lsofRunner(lsof)),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
      );
      assert.deepEqual(removed, []);
      assert.deepEqual(yield* fs.readDirectory(versionsDir), ["1.0.0"]);
    }),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
    "keeps a runtime a process runs through a symlink",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { baseDir, versionsDir } = yield* setup(["1.0.0", "1.1.0"]);
        const entry = path.join(versionsDir, "1.0.0", "t3");
        yield* fs.copyFile("/bin/sleep", entry);
        yield* fs.chmod(entry, 0o755);
        const link = path.join(baseDir, "t3");
        yield* fs.symlink(entry, link);
        // Its argv names only the link, as with `t3 serve` run from PATH. Removing the link after
        // spawning leaves the process's executable as the only reference.
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.spawn(ChildProcess.make(link, ["30"]));
        yield* fs.remove(link);

        const removed = yield* prunePinnedRuntimes({ baseDir, keep: ["2.0.0"] }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: baseDir }),
          Effect.provide(ProcessRunner.layer),
        );
        assert.deepEqual(removed, ["1.1.0"]);
      }),
  );
});
