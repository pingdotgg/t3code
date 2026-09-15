import { ProviderSetupError, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import { makeProviderCliInstallation } from "./ProviderCliInstallation.ts";
import type { ProviderCliRelease } from "./providerCliRelease.ts";

const contents = new TextEncoder().encode("fixture runtime");
const asset: ProviderCliRelease = {
  version: "1.2.3",
  url: "https://downloads.claude.ai/fixture",
  bytes: contents.byteLength,
  sha256: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
  format: "binary",
  executable: "claude",
};

const makeHarness = Effect.fn("test.makeCliInstallation")(function* (
  options: {
    readonly hash?: string;
    readonly reportedVersion?: string;
    readonly waitForDownload?: Deferred.Deferred<void>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-install-test-" });
  const requested = yield* Deferred.make<void>();
  let activated: string | null = null;
  let probes = 0;
  let downloads = 0;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.sync(() => {
      probes++;
      const stdout = Stream.succeed(new TextEncoder().encode(options.reportedVersion ?? "1.2.3"));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const installation = yield* makeProviderCliInstallation({
    baseDir,
    resolveRelease: () => Effect.succeed({ ...asset, sha256: options.hash ?? asset.sha256 }),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          downloads++;
          yield* Deferred.succeed(requested, undefined);
          if (options.waitForDownload) yield* Deferred.await(options.waitForDownload);
          return HttpClientResponse.fromWeb(request, new Response(contents));
        }),
      ),
    ),
  );
  return {
    installation,
    requested,
    baseDir,
    downloads: () => downloads,
    probes: () => probes,
    activated: () => activated,
    activate: (executable: string) =>
      Effect.sync(() => {
        activated = executable;
      }),
  };
});

const terminal = (installation: Effect.Success<ReturnType<typeof makeProviderCliInstallation>>) =>
  installation.changes("claudeAgent").pipe(
    Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe("managed CLI installation", () => {
  it.effect("does not publish a default runtime when activation is rejected", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.installation.start("claudeAgent", () =>
        Effect.fail(
          new ProviderSetupError({
            instanceId: ProviderInstanceId.make("claude"),
            operation: "install",
            detail: "Settings changed during installation.",
          }),
        ),
      );
      expect((yield* terminal(harness.installation)).phase).toBe("failed");
      const fs = yield* FileSystem.FileSystem;
      expect(
        yield* fs.exists(`${harness.installation.directory("claudeAgent")}/installed.json`),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves the selected executable when a later update fails verification", () =>
    Effect.gen(function* () {
      let hash = asset.sha256;
      const harness = yield* makeHarness({
        get hash() {
          return hash;
        },
      });
      yield* harness.installation.start("claudeAgent", harness.activate);
      expect((yield* terminal(harness.installation)).phase).toBe("succeeded");
      const previousExecutable = harness.activated();
      hash = "0".repeat(64);
      yield* harness.installation.start("claudeAgent", harness.activate);
      expect((yield* terminal(harness.installation)).phase).toBe("failed");
      expect(harness.activated()).toBe(previousExecutable);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.readFileString(previousExecutable!)).toBe("fixture runtime");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "verifies the download before selecting the executable and persists the installed version",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const start = yield* harness.installation.start("claudeAgent", harness.activate);
        const done = yield* terminal(harness.installation);
        expect(done).toMatchObject({
          phase: "succeeded",
          operationId: start.operationId,
          installedVersion: "1.2.3",
        });
        expect(harness.probes()).toBe(1);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(harness.activated()!)).toBe("fixture runtime");
        expect(
          yield* fs.readFileString(
            `${harness.installation.directory("claudeAgent")}/installed.json`,
          ),
        ).toContain("1.2.3");
        yield* harness.installation.start("claudeAgent", harness.activate);
        expect((yield* terminal(harness.installation)).message).toBe("Already up to date.");
        expect(harness.downloads()).toBe(1);
        yield* harness.installation.remove("claudeAgent", Effect.void);
        expect(yield* fs.exists(harness.installation.directory("claudeAgent"))).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("never executes or activates a download with the wrong checksum", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ hash: "0".repeat(64) });
      yield* harness.installation.start("claudeAgent", harness.activate);
      expect((yield* terminal(harness.installation)).phase).toBe("failed");
      expect(harness.probes()).toBe(0);
      expect(harness.activated()).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("rejects an executable that reports a different version", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ reportedVersion: "9.9.9" });
      yield* harness.installation.start("claudeAgent", harness.activate);
      expect((yield* terminal(harness.installation)).phase).toBe("failed");
      expect(harness.activated()).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("deduplicates starts, rejects stale cancellation, and cancels without activation", () =>
    Effect.gen(function* () {
      const waitForDownload = yield* Deferred.make<void>();
      const harness = yield* makeHarness({ waitForDownload });
      const first = yield* harness.installation.start("claudeAgent", harness.activate);
      yield* Deferred.await(harness.requested);
      const second = yield* harness.installation.start("claudeAgent", harness.activate);
      expect(second.operationId).toBe(first.operationId);
      expect(
        (yield* Effect.flip(harness.installation.remove("claudeAgent", Effect.void))).message,
      ).toContain("Cancel the installation");
      expect(
        (yield* Effect.flip(harness.installation.cancel("claudeAgent", "stale"))).message,
      ).toContain("no longer current");
      expect((yield* harness.installation.cancel("claudeAgent", first.operationId!)).phase).toBe(
        "cancelled",
      );
      expect(harness.activated()).toBeNull();
      const fs = yield* FileSystem.FileSystem;
      expect(
        (yield* fs.readDirectory(harness.installation.directory("claudeAgent"))).some((name) =>
          name.startsWith(".download-"),
        ),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
