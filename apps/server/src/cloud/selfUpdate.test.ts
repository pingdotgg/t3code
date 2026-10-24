import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  ServerSelfUpdateError,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderInstallLock from "../provider/ProviderInstallLock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerAutoUpdater from "../updates/ServerAutoUpdater.ts";
import * as UpdateWindow from "../updates/UpdateWindow.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly beforeDownload?: Effect.Effect<void>;
  readonly beforePreflight?: Effect.Effect<void>;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly orchestrationProtocol?: number;
  readonly lastOutcome?: ServiceLauncherClient.ServiceLauncherClient["Service"]["lastOutcome"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
  /** The newest published release; change it to publish another. */
  readonly release?: { version: string };
}

const archiveBytes = new TextEncoder().encode("not really a tarball");
const releaseHttpClient = (
  order: string[],
  release: { readonly version: string },
  beforeDownload?: Effect.Effect<void>,
) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.startsWith("https://api.github.com/")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify([{ tag_name: `v${release.version}` }])),
        );
      }
      if (request.url.endsWith("/SHA256SUMS")) {
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes));
        const hex = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${hex}  t3-${release.version}-linux-x64.tar.gz\n`),
        );
      }
      if (beforeDownload) yield* beforeDownload;
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

const noStaging = { capability: null, stage: () => Effect.die("unused") } as const;

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const release = options.release ?? { version: "1.1.0" };
  const order: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "tar") {
          order.push("extract");
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
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
        }
        order.push("preflight");
        if (options.beforePreflight) yield* options.beforePreflight;
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: release.version, reason: "local update required" }
            : {
                status: "ready",
                version: release.version,
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
                orchestrationProtocol:
                  options.orchestrationProtocol ?? ORCHESTRATION_PROTOCOL_VERSION,
              };
        return {
          stdout: JSON.stringify(result),
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
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
    lastOutcome: options.lastOutcome,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const httpClient = releaseHttpClient(order, release, options.beforeDownload);
  const serverConfig = { ...config, mode: options.mode ?? "web" };
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(ServerConfig.layer(serverConfig)),
  );
  return { selfUpdate, order, launcher, httpClient, serverConfig, release };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect("marks running threads at the boot-service handoff", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          ...noStaging,
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({
                targetVersion: "1.1.0",
                method: "boot-service" as const,
                updateId: "update-id",
              }),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-running")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );

      expect(events).toEqual(["downloading", "prepare", "installing"]);
    }),
  );

  it.effect("marks desktop threads only when the prepared update commits", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-running-desktop");
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          ...noStaging,
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(
              Effect.as({
                targetVersion: "1.2.0",
                method: "desktop-app" as const,
                desktopUpdateToken: "desktop-token",
              }),
            ),
          commitDesktopUpdate: () =>
            Effect.sync(() => events.push("commit")).pipe(Effect.andThen(Effect.fail(commitError))),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [threadId];
        }),
        clear: (threadIds) => Effect.sync(() => void events.push(`clear:${threadIds.join(",")}`)),
      });

      yield* selfUpdate.update({ targetVersion: "1.2.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );
      expect(events).toEqual(["installing"]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual(["installing", "prepare", "commit", `clear:${threadId}`]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual([
        "installing",
        "prepare",
        "commit",
        `clear:${threadId}`,
        "prepare",
        "commit",
        `clear:${threadId}`,
      ]);
    }),
  );

  it.effect("keeps continuation markers after the boot-service handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          ...noStaging,
          update: (
            _input,
            reportProgress = () => Effect.void,
            onHandoffAccepted = () => Effect.void,
          ) =>
            reportProgress("installing").pipe(
              Effect.andThen(onHandoffAccepted()),
              Effect.andThen(Effect.interrupt),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-boot-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      const exit = yield* selfUpdate
        .update({ targetVersion: "1.1.0", continueRunningThreads: true })
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("clears continuation markers for mixed failure and interrupt causes", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          ...noStaging,
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "failed-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(
              Effect.andThen(
                Effect.failCause(
                  Cause.fromReasons([
                    Cause.makeFailReason(commitError),
                    Cause.makeInterruptReason(),
                  ]),
                ),
              ),
            ),
        },
        prepare: Effect.sync(() => [ThreadId.make("thread-failed-desktop-install")]),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate.commitDesktopUpdate("failed-desktop-token").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false);
      }
      expect(events).toEqual(["clear"]);
    }),
  );

  it.effect.each([ORCHESTRATION_PROTOCOL_VERSION, ORCHESTRATION_PROTOCOL_VERSION + 1])(
    "stages and preflights before asking the launcher for an update ID (protocol: %s)",
    (orchestrationProtocol) =>
      Effect.gen(function* () {
        const { selfUpdate, order } = yield* makeHarness({ orchestrationProtocol });
        expect(yield* selfUpdate.update({ targetVersion: "1.1.0" })).toEqual({
          targetVersion: "1.1.0",
          method: "boot-service",
          updateId: "launcher-id",
        });
        expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      }),
  );

  // regression: #5181 make remote updates rollback-safe
  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact t3 version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("delegates desktop-managed updates to the desktop app when available", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness({
        mode: "desktop",
        desktopAppUpdate: {
          available: true,
          run: (reportProgress) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
            ),
          commit: () => Effect.never,
        },
      });
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" }, (stage) =>
        Effect.sync(() => void stages.push(stage)),
      );
      expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
      expect(stages).toEqual(["downloading", "installing"]);
      expect(order).toEqual([]);
    }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );

  it.effect("keeps preparing after the progress stream closes", () =>
    Effect.gen(function* () {
      const releaseDownload = yield* Deferred.make<void>();
      const sawDownloading = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        beforeDownload: Deferred.await(releaseDownload),
        requestUpdate: () =>
          Effect.sync(() => {
            order.push("accept");
          }).pipe(Effect.andThen(Deferred.succeed(accepted, undefined)), Effect.as("launcher-id")),
      });

      const consumed = yield* ServerSelfUpdate.updateProgressStream(selfUpdate, {
        targetVersion: "1.1.0",
      }).pipe(
        Stream.tap((event) =>
          event.type === "progress" && event.stage === "downloading"
            ? Deferred.succeed(sawDownloading, undefined)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* Deferred.await(sawDownloading);
      // The socket drop ends the stream. The download is still held.
      yield* Fiber.interrupt(consumed);
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );

      yield* Deferred.succeed(releaseDownload, undefined);
      // `installing` is offered only after the stream queue has shut down.
      yield* Deferred.await(accepted);
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
    }),
  );

  it.effect("stages without handing off and returns the staged client protocol", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { selfUpdate, order, serverConfig } = yield* makeHarness();
      expect(yield* selfUpdate.stage("1.1.0", ORCHESTRATION_PROTOCOL_VERSION)).toEqual({
        orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
      });
      expect(order).toEqual(["download", "extract", "preflight"]);
      expect(
        yield* fs.readFileString(
          path.join(serverConfig.baseDir, "runtime", "versions", "1.1.0", ".install-complete"),
        ),
      ).toBe("1.1.0\n");
      // Staging releases the in-flight guard, so a later update still runs.
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" })).updateId).toBe("launcher-id");
    }),
  );

  it.effect("refuses to stage while an update is in flight", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.stage("1.1.1").pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      yield* Fiber.join(first);
    }),
  );
});

const backgroundUpdates = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  options: {
    readonly open: { value: boolean };
    readonly automaticUpdates?: boolean;
    readonly beforeLock?: Effect.Effect<void>;
  },
) => {
  const held: string[] = [];
  const windows: Array<{ readonly restartsServer?: boolean } | undefined> = [];
  const pass = ServerAutoUpdater.makeUpdatePass().pipe(
    Effect.flatMap(({ pass }) => Effect.succeed(pass)),
    Effect.provideService(ServerSelfUpdate.ServerSelfUpdate, harness.selfUpdate),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, harness.launcher),
    Effect.provideService(HttpClient.HttpClient, harness.httpClient),
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layer(harness.serverConfig),
        ServerSettings.layerTest({ automaticUpdates: options.automaticUpdates ?? true }),
        Layer.mock(UpdateWindow.UpdateWindow)({
          isOpen: () => Effect.sync(() => options.open.value),
          runIfOpen: (effect, windowOptions) =>
            Effect.suspend(() => {
              windows.push(windowOptions);
              return options.open.value ? Effect.asSome(effect) : Effect.succeedNone;
            }),
        }),
        Layer.mock(ProviderInstallLock.ProviderInstallLock)({
          tryRun: (key, run) =>
            Effect.acquireUseRelease(
              Effect.sync(() => void held.push(key)),
              () =>
                (options.beforeLock ?? Effect.void).pipe(
                  Effect.andThen(run(() => Effect.void)),
                  Effect.map(Option.some),
                ),
              () => Effect.sync(() => void held.pop()),
            ),
        }),
      ),
    ),
  );
  return { pass, held, windows };
};

it.layer(NodeServices.layer)("background server updates", (it) => {
  it.effect.each(["lock", "preflight"] as const)(
    "postpones a restart when the window closes during %s and retries the staged target",
    (during) =>
      Effect.gen(function* () {
        const accepted = yield* Deferred.make<void>();
        const open = { value: false };
        let preflights = 0;
        let closeAtLock = during === "lock";
        const harness = yield* makeHarness({
          beforePreflight: Effect.sync(() => {
            if (++preflights === 2 && during === "preflight") open.value = false;
          }),
          requestUpdate: () => Deferred.succeed(accepted, undefined).pipe(Effect.as("launcher-id")),
        });
        const updates = backgroundUpdates(harness, {
          open,
          beforeLock: Effect.sync(() => {
            if (closeAtLock) open.value = false;
            closeAtLock = false;
          }),
        });
        const pass = yield* updates.pass;
        yield* pass;
        open.value = true;
        yield* pass.pipe(Effect.raceFirst(Deferred.await(accepted)));
        expect(yield* Deferred.isDone(accepted)).toBe(false);
        expect(updates.held).toEqual([]);
        open.value = true;
        const handoff = yield* Effect.forkChild(pass, { startImmediately: true });
        yield* Deferred.await(accepted);
        expect(updates.held).toEqual(["server-restart"]);
        expect(harness.order.filter((step) => step === "download")).toHaveLength(1);
        while (handoff.pollUnsafe() === undefined) {
          yield* TestClock.adjust(Duration.minutes(1));
        }
        yield* Fiber.join(handoff);
      }),
  );

  it.effect.each(["download", "protocol"] as const)(
    "clears a superseded release and retries download failures but skips protocol mismatches: %s",
    (failure) =>
      Effect.gen(function* () {
        const accepted = yield* Deferred.make<string>();
        const release = { version: "1.1.0" };
        let downloadFails = failure === "download";
        const options = {
          release,
          orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
          beforeDownload: Effect.sync(() => {
            if (downloadFails && release.version === "1.2.0") {
              throw new Error("download failed");
            }
          }),
          requestUpdate: ({ targetVersion }: { readonly targetVersion: string }) =>
            Deferred.succeed(accepted, targetVersion).pipe(Effect.as("launcher-id")),
        };
        const harness = yield* makeHarness(options);
        const open = { value: false };
        const pass = yield* backgroundUpdates(harness, { open }).pass;
        yield* pass;
        release.version = "1.2.0";
        if (failure === "protocol") options.orchestrationProtocol += 1;
        yield* TestClock.adjust(Duration.hours(1));
        yield* pass;
        open.value = true;
        yield* pass.pipe(Effect.raceFirst(Deferred.await(accepted)));
        expect(yield* Deferred.isDone(accepted)).toBe(false);

        const downloads = harness.order.filter((step) => step === "download").length;
        downloadFails = false;
        options.orchestrationProtocol = ORCHESTRATION_PROTOCOL_VERSION;
        yield* TestClock.adjust(Duration.hours(1));
        if (failure === "protocol") {
          yield* pass;
          expect(yield* Deferred.isDone(accepted)).toBe(false);
          expect(harness.order.filter((step) => step === "download")).toHaveLength(downloads);
        } else {
          const handoff = yield* Effect.forkChild(pass, { startImmediately: true });
          expect(yield* Deferred.await(accepted)).toBe("1.2.0");
          expect(harness.order.filter((step) => step === "download")).toHaveLength(downloads + 1);
          while (handoff.pollUnsafe() === undefined) {
            yield* TestClock.adjust(Duration.minutes(1));
          }
          yield* Fiber.join(handoff);
        }
      }),
  );

  it.effect("stages once, waits for the update window, then hands off under the restart lock", () =>
    Effect.gen(function* () {
      const accepted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        requestUpdate: () => Deferred.succeed(accepted, undefined).pipe(Effect.as("launcher-id")),
      });
      const open = { value: false };
      const updates = backgroundUpdates(harness, { open });
      const pass = yield* updates.pass;

      yield* pass;
      yield* pass;
      expect(harness.order).toEqual(["download", "extract", "preflight"]);
      expect(updates.windows).toEqual([{ restartsServer: true }, { restartsServer: true }]);

      open.value = true;
      const handoff = yield* Effect.forkChild(pass, { startImmediately: true });
      yield* Deferred.await(accepted);
      // Turn starts wait on this lock until the launcher stops the server.
      expect(updates.held).toEqual(["server-restart"]);
      expect(harness.order.filter((step) => step === "download")).toHaveLength(1);
      while (handoff.pollUnsafe() === undefined) {
        yield* TestClock.adjust(Duration.minutes(1));
      }
      yield* Fiber.join(handoff);
      expect(updates.held).toEqual([]);
    }),
  );

  it.effect(
    "hands off a newer release that supersedes the staged one before the window opens",
    () =>
      Effect.gen(function* () {
        const requested: string[] = [];
        const accepted = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          requestUpdate: ({ targetVersion }) =>
            Effect.sync(() => void requested.push(targetVersion)).pipe(
              Effect.andThen(Deferred.succeed(accepted, undefined)),
              Effect.as("launcher-id"),
            ),
        });
        const open = { value: false };
        const pass = yield* backgroundUpdates(harness, { open }).pass;

        yield* pass;
        harness.release.version = "1.2.0";
        yield* TestClock.adjust(Duration.hours(1));
        yield* pass;
        // The same newest release again is not downloaded twice.
        yield* TestClock.adjust(Duration.hours(1));
        yield* pass;
        expect(harness.order.filter((step) => step === "download")).toHaveLength(2);

        open.value = true;
        const handoff = yield* Effect.forkChild(pass, { startImmediately: true });
        yield* Deferred.await(accepted);
        expect(requested).toEqual(["1.2.0"]);
        while (handoff.pollUnsafe() === undefined) {
          yield* TestClock.adjust(Duration.minutes(1));
        }
        yield* Fiber.join(handoff);
      }),
  );

  it.effect("skips a target the launcher rolled back or failed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        lastOutcome: {
          id: "update-1",
          fromVersion: "0.0.45",
          targetVersion: "1.1.0",
          status: "rolled-back",
        },
      });
      const pass = yield* backgroundUpdates(harness, { open: { value: true } }).pass;
      yield* pass;
      expect(harness.order).toEqual([]);
    }),
  );

  it.effect.each([false, true])(
    "skips a target whose client protocol differs, without staging it again (cached: %s)",
    (cached) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const harness = yield* makeHarness({
          orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION + 1,
        });
        const versionsDir = path.join(harness.serverConfig.baseDir, "runtime", "versions");
        if (cached) yield* harness.selfUpdate.stage("1.1.0");
        const pass = yield* backgroundUpdates(harness, { open: { value: true } }).pass;
        yield* pass;
        expect(harness.order).toEqual([
          "download",
          "extract",
          "preflight",
          ...(cached ? ["preflight"] : []),
        ]);
        expect(yield* fs.readDirectory(versionsDir)).toEqual(cached ? ["1.1.0"] : []);
        const order = [...harness.order];
        yield* TestClock.adjust(Duration.hours(2));
        yield* pass;
        expect(harness.order).toEqual(order);
        expect(yield* fs.readDirectory(versionsDir)).toEqual(cached ? ["1.1.0"] : []);
        if (cached) {
          expect(
            yield* fs.readFileString(path.join(versionsDir, "1.1.0", ".install-complete")),
          ).toBe("1.1.0\n");
        }
      }),
  );

  it.effect("does nothing when automatic updates are off or the server is not a service", () =>
    Effect.gen(function* () {
      const off = yield* makeHarness();
      yield* yield* backgroundUpdates(off, { open: { value: true }, automaticUpdates: false }).pass;
      const unmanaged = yield* makeHarness({ managed: false });
      yield* yield* backgroundUpdates(unmanaged, { open: { value: true } }).pass;
      expect([...off.order, ...unmanaged.order]).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)("pruning runtimes on start", (it) => {
  const staleVersion = "0.0.1";
  const otherProcesses = ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout: "p42\nftxt\nn/bin/sh\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

  const pruneOnStart = Effect.fn("test.prune_on_start")(function* (input: {
    readonly executable: "own runtime" | "elsewhere";
    readonly managed?: boolean;
    readonly symlinkedHome?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-prune-on-start-" });
    const realHome = path.join(tempDir, "home");
    const baseDir = input.symlinkedHome ? path.join(tempDir, "linked-home") : realHome;
    const versionsDir = path.join(baseDir, "runtime", "versions");
    yield* TestClock.setTime(24 * 60 * 60 * 1000);
    for (const version of [staleVersion, packageJson.version]) {
      const directory = path.join(realHome, "runtime", "versions", version);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "t3"), "");
      const sentinel = path.join(directory, ".install-complete");
      yield* fs.writeFileString(sentinel, `${version}\n`);
      yield* fs.utimes(sentinel, 0, 0);
    }
    if (input.symlinkedHome) yield* fs.symlink(realHome, baseDir);
    // Like `process.execPath`, the running runtime is reported by its real path.
    const executablePath =
      input.executable === "own runtime"
        ? yield* fs.realPath(path.join(versionsDir, packageJson.version, "t3"))
        : "/usr/local/bin/node";
    const removed = yield* ServerSelfUpdate.pruneRuntimesOnStart({
      baseDir,
      managed: input.managed ?? false,
    }).pipe(
      Effect.provideService(HostProcess.ExecutablePath, executablePath),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(ProcessRunner.ProcessRunner, otherProcesses),
    );
    return { removed, remaining: (yield* fs.readDirectory(versionsDir)).toSorted() };
  });

  // The SSH launcher runs `t3 serve` straight from the pinned runtime, with no boot service.
  it.effect("prunes for a server started from its home's pinned runtime", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "own runtime" });
      expect(removed).toEqual([staleVersion]);
      expect(remaining).toEqual([packageJson.version]);
    }),
  );

  it.effect("recognizes its runtime through a symlinked T3 home", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "own runtime", symlinkedHome: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("prunes for a boot-service server wherever it runs from", () =>
    Effect.gen(function* () {
      const { removed } = yield* pruneOnStart({ executable: "elsewhere", managed: true });
      expect(removed).toEqual([staleVersion]);
    }),
  );

  it.effect("leaves runtimes alone for an unmanaged server started elsewhere", () =>
    Effect.gen(function* () {
      const { removed, remaining } = yield* pruneOnStart({ executable: "elsewhere" });
      expect(removed).toEqual([]);
      expect(remaining).toEqual([staleVersion, packageJson.version].toSorted());
    }),
  );
});
