import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopTelemetryRequestDesktopUpdate,
  DesktopUpdateStatusReport,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopRemoteUpdates from "./DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

// The remote flow hops between the test runtime's fibers and the updater's
// runPromise-driven event handlers, so settling needs real microtask turns,
// not just fiber yields.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i += 1) {
    yield* Effect.yieldNow;
    yield* Effect.promise(() => Promise.resolve());
  }
});

const request = (requestId: string): DesktopTelemetryRequestDesktopUpdate => ({
  version: 1,
  type: "requestDesktopUpdate",
  requestId,
});

function runRemoteUpdatesTest(
  harness: ReturnType<typeof makeHarness>,
  body: (context: {
    readonly reports: DesktopUpdateStatusReport[];
    readonly requests: Queue.Queue<DesktopTelemetryRequestDesktopUpdate>;
  }) => Effect.Effect<void, never, DesktopUpdates.DesktopUpdates>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<DesktopTelemetryRequestDesktopUpdate>();
      const reports: DesktopUpdateStatusReport[] = [];
      const publisher = DesktopTelemetryPublisher.DesktopTelemetryPublisher.of({
        latest: Effect.succeedNone,
        changes: Stream.empty,
        encoded: Stream.empty,
        handleControl: () => Effect.void,
        handleControlForSource: () => Effect.void,
        removeControlSource: () => Effect.void,
        publishUpdateReport: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        updateRequests: Stream.fromQueue(requests),
      });

      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* DesktopRemoteUpdates.listen.pipe(
        Effect.provideService(DesktopTelemetryPublisher.DesktopTelemetryPublisher, publisher),
      );
      yield* settle;
      yield* body({ reports, requests });
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
}

function terminalReports(reports: DesktopUpdateStatusReport[]): DesktopUpdateStatusReport[] {
  return reports.filter((report) => report.outcome !== undefined);
}

describe("DesktopRemoteUpdates", () => {
  it.effect("drives check, download, and install with no local confirmation", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-1"));
        yield* settle;
        assert.equal(harness.checkCount(), 1);

        harness.emit("update-available", { version: "1.2.4" });
        yield* settle;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* settle;

        const terminals = terminalReports(reports);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.outcome, "installing");
        assert.equal(terminals[0]?.requestId, "req-1");
        assert.equal(harness.quitAndInstalls(), 1);

        // The mirror stamped the in-run state changes with the request id.
        const statuses = reports
          .filter((report) => report.requestId === "req-1")
          .map((report) => report.state.status);
        assert.include(statuses, "available");
        assert.include(statuses, "downloaded");
      }),
    );
  });

  it.effect("reports a failed outcome when quitAndInstall fails", () => {
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("spawn failed"),
        }),
      ),
    });

    return runRemoteUpdatesTest(harness, ({ reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-4"));
        yield* settle;
        harness.emit("update-available", { version: "1.2.4" });
        yield* settle;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* settle;

        // Install failures reduce to status "downloaded" + errorContext
        // "install"; the run must still end with a failed report after the
        // premature "installing" one.
        const terminals = terminalReports(reports);
        assert.deepEqual(
          terminals.map((report) => report.outcome),
          ["installing", "failed"],
        );
        assert.equal(terminals[1]?.state.errorContext, "install");
      }),
    );
  });

  it.effect("does not misread a lingering install error as a failed retry", () => {
    let installAttempts = 0;
    const harness = makeHarness({
      quitAndInstall: Effect.suspend(() => {
        installAttempts += 1;
        return installAttempts === 1
          ? Effect.fail(
              new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
                channel: "latest",
                isSilent: true,
                isForceRunAfter: true,
                cause: new Error("first attempt failed"),
              }),
            )
          : Effect.void;
      }),
    });

    return runRemoteUpdatesTest(harness, ({ reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-5"));
        yield* settle;
        harness.emit("update-available", { version: "1.2.4" });
        yield* settle;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* settle;
        // First run failed; state is "downloaded" with a lingering
        // errorContext "install". The retry succeeds and must not report
        // that leftover as a fresh failure.
        yield* Queue.offer(requests, request("req-6"));
        yield* settle;

        const retryTerminals = terminalReports(reports).filter(
          (report) => report.requestId === "req-6",
        );
        assert.deepEqual(
          retryTerminals.map((report) => report.outcome),
          ["installing"],
        );
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    );
  });

  it.effect("reports up-to-date without installing when there is no update", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-2"));
        yield* settle;
        harness.emit("update-not-available");
        yield* settle;

        const terminals = terminalReports(reports);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.outcome, "up-to-date");
        assert.equal(terminals[0]?.requestId, "req-2");
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });

  it.effect("fails fast with the disabled reason when updates are off", () => {
    const harness = makeHarness({ env: { T3CODE_DISABLE_AUTO_UPDATE: "true" } });

    return runRemoteUpdatesTest(harness, ({ reports, requests }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-3"));
        yield* settle;

        const terminals = terminalReports(reports);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.outcome, "failed");
        assert.equal(
          terminals[0]?.reason,
          "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.",
        );
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    );
  });
});
