import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { DesktopUpdateState, DesktopUpdateStatusReport } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopAppUpdate from "./DesktopAppUpdate.ts";

function makeState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "1.2.3",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    omittedReleaseCount: 0,
    ...overrides,
  };
}

function report(
  requestId: string,
  state: DesktopUpdateState,
  terminal?: {
    readonly outcome: DesktopUpdateStatusReport["outcome"];
    readonly reason?: string;
  },
): DesktopUpdateStatusReport {
  return {
    version: 1,
    type: "desktopUpdateStatus",
    requestId,
    ...(terminal?.outcome === undefined ? {} : { outcome: terminal.outcome }),
    ...(terminal?.reason === undefined ? {} : { reason: terminal.reason }),
    state,
  };
}

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly controlFd?: number | undefined;
  /** Reports emitted for the run, given the requestId the service generated.
      The stream ends after the last one unless `keepOpen` is set. */
  readonly reports?: (requestId: string) => readonly DesktopUpdateStatusReport[];
  readonly keepOpen?: boolean;
}

const makeHarness = Effect.fn("test.make_desktop_app_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-app-update-test-" });
  const requestIdDeferred = yield* Deferred.make<string>();
  const baseConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const config: ServerConfig.ServerConfig["Service"] = {
    ...baseConfig,
    mode: options.mode ?? "desktop",
    ...("controlFd" in options
      ? { desktopTelemetryControlFd: options.controlFd }
      : { desktopTelemetryControlFd: 5 }),
  };
  const reportsForRun = options.reports ?? (() => []);
  const changes = Stream.unwrap(
    Deferred.await(requestIdDeferred).pipe(
      Effect.map((requestId) => {
        const emitted = Stream.fromIterable(reportsForRun(requestId));
        return options.keepOpen ? Stream.concat(emitted, Stream.never) : emitted;
      }),
    ),
  );

  const service = yield* DesktopAppUpdate.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopTelemetryReceiver.layerTest({
          requestDesktopUpdate: (requestId) =>
            Deferred.succeed(requestIdDeferred, requestId).pipe(Effect.asVoid),
          desktopUpdates: Effect.succeed({
            latest: Option.none<DesktopUpdateStatusReport>(),
            changes,
          }),
        }),
        ServerConfig.layer(config),
      ),
    ),
  );
  return { service };
});

it.layer(NodeServices.layer)("desktop app update", (it) => {
  it.effect("is unavailable without desktop mode or the control fd", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness({ mode: "web" });
      expect(web.service.available).toBe(false);
      const noFd = yield* makeHarness({ controlFd: undefined });
      expect(noFd.service.available).toBe(false);
      expect((yield* noFd.service.run(() => Effect.void).pipe(Effect.flip)).reason).toContain(
        "not started by the T3 Code desktop app",
      );
      const desktop = yield* makeHarness();
      expect(desktop.service.available).toBe(true);
    }),
  );

  it.effect("collapses state reports into progress stages and succeeds on installing", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "checking" })),
          report(requestId, makeState({ status: "available", availableVersion: "1.2.4" })),
          report(requestId, makeState({ status: "downloading", downloadPercent: 40 })),
          // Reports from another run must be ignored.
          report("other-run", makeState({ status: "error", message: "unrelated" })),
          report(requestId, makeState({ status: "downloaded", downloadedVersion: "1.2.4" }), {
            outcome: "ready-to-install",
          }),
        ],
      });
      const stages: string[] = [];
      const result = yield* service.run((stage) => Effect.sync(() => void stages.push(stage)));
      expect(result).toEqual({
        targetVersion: "1.2.4",
        method: "desktop-app",
        desktopUpdateToken: expect.any(String),
      });
      // "downloading" is not repeated for every download report.
      expect(stages).toEqual(["downloading", "installing"]);

      // Success releases the in-flight guard: if the desktop rejected the
      // install after reporting, the server must accept a retry instead of
      // refusing until restart. (The second run fails differently because
      // the stub report stream is exhausted.)
      const retry = yield* service.run(() => Effect.void).pipe(Effect.flip);
      expect(retry.reason).not.toBe("A desktop app update is already in progress.");
    }),
  );

  it.effect("maps up-to-date and failed outcomes to readable errors", () =>
    Effect.gen(function* () {
      const upToDate = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "up-to-date" }), { outcome: "up-to-date" }),
        ],
      });
      expect((yield* upToDate.service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "The T3 Code desktop app on this machine is already up to date on 1.2.3.",
      );

      const failed = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "error", message: "feed unreachable" }), {
            outcome: "failed",
            reason: "feed unreachable",
          }),
        ],
      });
      expect((yield* failed.service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "feed unreachable",
      );
    }),
  );

  it.effect("replays a retained commit failure for the preparation token", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "downloaded", downloadedVersion: "1.2.4" }), {
            outcome: "ready-to-install",
          }),
          report(
            requestId,
            makeState({
              status: "downloaded",
              downloadedVersion: "1.2.4",
              errorContext: "install",
              message: "installer refused",
            }),
            { outcome: "failed", reason: "installer refused" },
          ),
        ],
      });
      const prepared = yield* service.run(() => Effect.void);

      expect(
        (yield* service.commit(prepared.desktopUpdateToken ?? "missing").pipe(Effect.flip)).reason,
      ).toBe("installer refused");
    }),
  );

  it.effect("fails when the desktop stops reporting before a terminal outcome", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [report(requestId, makeState({ status: "checking" }))],
      });
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "The desktop app stopped reporting its update.",
      );
    }),
  );

  it.effect("allows only one desktop update at a time", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ reports: () => [], keepOpen: true });
      const first = yield* Effect.forkChild(
        service.run(() => Effect.void),
        {
          startImmediately: true,
        },
      );
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "A desktop app update is already in progress.",
      );
      yield* Fiber.interrupt(first);

      const retry = yield* Effect.forkChild(
        service.run(() => Effect.void),
        {
          startImmediately: true,
        },
      );
      yield* Effect.yieldNow;
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "A desktop app update is already in progress.",
      );
      yield* Fiber.interrupt(retry);
    }),
  );
});
