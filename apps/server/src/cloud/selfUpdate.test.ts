import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderInstallLock from "../provider/ProviderInstallLock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerAutoUpdater from "../updates/ServerAutoUpdater.ts";
import * as UpdateWindow from "../updates/UpdateWindow.ts";
import * as RestartWork from "../updates/RestartWork.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly preflightDuration?: Duration.Input;
  readonly preflightStarted?: Deferred.Deferred<void>;
  readonly beforeDownload?: Effect.Effect<void>;
  readonly beforePreflight?: Effect.Effect<void>;
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly orchestrationProtocol?: number;
  readonly lastOutcome?: ServiceLauncherClient.ServiceLauncherClient["Service"]["lastOutcome"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
  readonly policy?: ManagedPolicyDocument;
  /** The newest published release; change it to publish another. */
  readonly release?: { version: string; withdrawn?: boolean };
}

const archiveBytes = new TextEncoder().encode("not really a tarball");
const releaseHttpClient = (
  order: string[],
  urls: string[],
  release: { readonly version: string; readonly withdrawn?: boolean },
  beforeDownload?: Effect.Effect<void>,
) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      urls.push(request.url);
      if (request.url.startsWith("https://api.github.com/")) {
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify(release.withdrawn ? [] : [{ tag_name: `v${release.version}` }]),
          ),
        );
      }
      if (request.url.endsWith(".yml")) {
        return HttpClientResponse.fromWeb(request, new Response(`version: ${release.version}\n`));
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

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const release: { version: string; withdrawn?: boolean } = options.release ?? { version: "1.1.0" };
  const order: string[] = [];
  const urls: string[] = [];
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
        if (options.preflightStarted) yield* Deferred.succeed(options.preflightStarted, undefined);
        if (options.preflightDuration !== undefined) {
          // Like the real runner, fail once the caller's timeout elapses.
          const timeout = Duration.fromInputUnsafe(input.timeout ?? "60 seconds");
          const finished = yield* Effect.sleep(options.preflightDuration).pipe(
            Effect.timeoutOption(timeout),
          );
          if (finished._tag === "None") {
            return yield* new ProcessRunner.ProcessTimeoutError({
              command: input.command,
              argumentCount: input.args.length,
              timeoutMs: Duration.toMillis(timeout),
            });
          }
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
  const httpClient = releaseHttpClient(order, urls, release, options.beforeDownload);
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
    Effect.provide(
      Layer.merge(ServerConfig.layer(serverConfig), ManagedPolicy.layerTest(options.policy)),
    ),
  );
  return { selfUpdate, order, urls, launcher, httpClient, serverConfig, release };
});

it.layer(NodeServices.layer)("server self update", (it) => {
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

  it.effect("refuses every update when the managed policy turns updates off", () =>
    Effect.gen(function* () {
      const policy: ManagedPolicyDocument = {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { updates: { mode: "off" } },
      };
      const service = yield* makeHarness({ policy });
      const desktop = yield* makeHarness({
        mode: "desktop",
        policy,
        desktopAppUpdate: {
          available: true,
          run: () => Effect.die("unexpected desktop app update run"),
          commit: () => Effect.never,
        },
      });
      for (const harness of [service, desktop]) {
        expect(
          (yield* harness.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
        ).toBe("Example Corp manages T3 Code updates.");
      }
      expect([...service.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("lets a user start an update, but only to stable without nightly", () =>
    Effect.gen(function* () {
      const { selfUpdate, order, urls } = yield* makeHarness({
        policy: {
          schemaVersion: 1,
          organization: "Example Corp",
          limits: {
            updates: {
              mode: "auto",
              allowNightly: false,
              feedUrl: "https://updates.example.com/t3code/",
            },
          },
        },
      });
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.2.0-nightly.20261028.1" }).pipe(Effect.flip))
          .reason,
      ).toBe("Example Corp manages T3 Code updates. Only stable releases can be installed.");
      expect(order).toEqual([]);
      // The mirror lists only 1.1.0's archive.
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "Example Corp's update mirror has no t3@1.2.0 for this machine.",
      );
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" })).updateId).toBe("launcher-id");
      // The release comes from the policy's mirror, not GitHub.
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls)
        expect(url).toMatch(/^https:\/\/updates\.example\.com\/t3code\/v1\.[12]\.0\//);
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

  // regression: #28198 a slow staged preflight on a loaded host no longer fails the update
  it.effect("waits for a staged preflight that takes a minute on a loaded host", () =>
    Effect.gen(function* () {
      const preflightStarted = yield* Deferred.make<void>();
      const { selfUpdate, order } = yield* makeHarness({
        preflightDuration: "60 seconds",
        preflightStarted,
      });
      const update = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(preflightStarted);
      yield* TestClock.adjust("60 seconds");
      const exit = yield* Fiber.await(update);
      expect(exit._tag === "Failure" ? String(exit.cause) : "launcher handoff").toBe(
        "launcher handoff",
      );
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
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
      yield* Fiber.interrupt(consumed);
      expect((yield* selfUpdate.update({ targetVersion: "1.2.0" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );

      yield* Deferred.succeed(releaseDownload, undefined);
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
    readonly policy?: ManagedPolicyDocument;
  },
) => {
  const held: string[] = [];
  const windows: Array<{ readonly restartsServer?: boolean } | undefined> = [];
  const pass = ServerAutoUpdater.makeUpdatePass().pipe(
    Effect.map(({ pass }) => pass),
    Effect.provideService(ServerSelfUpdate.ServerSelfUpdate, harness.selfUpdate),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, harness.launcher),
    Effect.provideService(HttpClient.HttpClient, harness.httpClient),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provide(
      Layer.mergeAll(
        RestartWork.layer,
        ManagedPolicy.layerTest(options.policy),
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
                  Effect.asSome,
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
        yield* TestClock.adjust(Duration.minutes(5));
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
          yield* TestClock.adjust(Duration.minutes(5));
          yield* Fiber.join(handoff);
        }
      }),
  );

  it.effect.each([false, true])(
    "holds the restart lock through accepted or timed-out handoff (%s), then permits another update",
    (timesOut) =>
      Effect.gen(function* () {
        const accepted = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          requestUpdate: () =>
            Deferred.succeed(accepted, undefined).pipe(
              Effect.andThen(
                timesOut
                  ? Effect.fail(
                      new ServiceLauncherClient.ServiceLauncherClientError({
                        operation: "timeout",
                      }),
                    )
                  : Effect.succeed("launcher-id"),
              ),
            ),
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
        yield* TestClock.adjust(Duration.seconds(30));
        // Turn starts wait on this lock until the launcher stops the server.
        expect(updates.held).toEqual(["server-restart"]);
        expect(harness.order.filter((step) => step === "download")).toHaveLength(1);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* Fiber.join(handoff);
        expect(updates.held).toEqual([]);
        yield* harness.selfUpdate.stage("1.1.0");
      }),
  );

  it.effect.each([false, true])(
    "clears a staged release that is superseded or withdrawn (%s)",
    (withdrawn) =>
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
        if (withdrawn) harness.release.withdrawn = true;
        else harness.release.version = "1.2.0";
        yield* TestClock.adjust(Duration.hours(1));
        yield* pass;
        // The same newest release again is not downloaded twice.
        yield* TestClock.adjust(Duration.hours(1));
        yield* pass;
        expect(harness.order.filter((step) => step === "download")).toHaveLength(withdrawn ? 1 : 2);

        open.value = true;
        if (withdrawn) {
          yield* pass.pipe(Effect.raceFirst(Deferred.await(accepted)));
          expect(requested).toEqual([]);
          return;
        }
        const handoff = yield* Effect.forkChild(pass, { startImmediately: true });
        yield* Deferred.await(accepted);
        expect(requested).toEqual(["1.2.0"]);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* Fiber.join(handoff);
      }),
  );

  it.effect("retries a refused handoff at the next release check, not every minute", () =>
    Effect.gen(function* () {
      let requests = 0;
      const harness = yield* makeHarness({
        requestUpdate: () =>
          Effect.sync(() => void requests++).pipe(
            Effect.andThen(
              Effect.fail(
                new ServiceLauncherClient.ServiceLauncherClientError({ operation: "send" }),
              ),
            ),
          ),
      });
      const pass = yield* backgroundUpdates(harness, { open: { value: true } }).pass;
      yield* pass;
      expect(requests).toBe(1);
      const preflights = harness.order.filter((step) => step === "preflight").length;
      yield* TestClock.adjust(Duration.minutes(1));
      yield* pass;
      expect(requests).toBe(1);
      expect(harness.order.filter((step) => step === "preflight")).toHaveLength(preflights);
      yield* TestClock.adjust(Duration.hours(1));
      yield* pass;
      expect(requests).toBe(2);
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

  it.effect("stages the release a policy's update mirror offers", () =>
    Effect.gen(function* () {
      const policy: ManagedPolicyDocument = {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { updates: { mode: "auto", feedUrl: "https://updates.example.com/t3code/" } },
      };
      const harness = yield* makeHarness({ policy });
      yield* yield* backgroundUpdates(harness, { open: { value: false }, policy }).pass;
      expect(harness.order).toContain("download");
      for (const url of harness.urls) {
        expect(url).toMatch(/^https:\/\/updates\.example\.com\/t3code\//);
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

it("a host crosses tracks only to a release that knows its whole database", () => {
  const cross = (
    serverVersion: string,
    targetVersion: string,
    targetDatabaseMigration: number | undefined,
    databaseMigration = 72,
  ) =>
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion,
      targetVersion,
      targetDatabaseMigration,
      databaseMigration: () => databaseMigration,
    });
  const nightly = "0.1.4-nightly.20261027.3796";

  expect(cross(nightly, "0.1.4", 72)).toBeNull();
  // Another client moved this host to a newer Nightly after the switch was planned.
  expect(cross(nightly, "0.1.4", 72, 73)).toContain("does not support yet");
  expect(cross(nightly, "0.1.4", undefined)).toContain("Cannot confirm");
  // A Stable tag can carry a migration the latest Nightly lacks.
  expect(cross("0.1.4", nightly, 72, 73)).toContain("does not support yet");
  expect(cross("0.1.3", "0.1.4", undefined)).toBeNull();
  // A database that exists but cannot be read proves nothing.
  expect(
    ServerSelfUpdate.trackSwitchBlockReason({
      serverVersion: nightly,
      targetVersion: "0.1.4",
      targetDatabaseMigration: 72,
      databaseMigration: () => undefined,
    }),
  ).toContain("Cannot confirm");
});
