import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopTelemetryRequestDesktopUpdate,
  DesktopTelemetryCommitDesktopUpdate,
  DesktopTelemetryCancelDesktopUpdate,
  DesktopUpdateStatusReport,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopRemoteUpdates from "./DesktopRemoteUpdates.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

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
    readonly commits: Queue.Queue<DesktopTelemetryCommitDesktopUpdate>;
    readonly cancellations: Queue.Queue<DesktopTelemetryCancelDesktopUpdate>;
  }) => Effect.Effect<void, never, DesktopUpdates.DesktopUpdates | DesktopState.DesktopState>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<DesktopTelemetryRequestDesktopUpdate>();
      const commits = yield* Queue.unbounded<DesktopTelemetryCommitDesktopUpdate>();
      const cancellations = yield* Queue.unbounded<DesktopTelemetryCancelDesktopUpdate>();
      const reports: DesktopUpdateStatusReport[] = [];
      const publisher = DesktopTelemetryPublisher.DesktopTelemetryPublisher.of({
        latest: Effect.succeedNone,
        changes: Stream.empty,
        encoded: Stream.empty,
        handleControlForSource: () => Effect.void,
        removeControlSource: () => Effect.void,
        publishUpdateReport: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        updateRequests: Stream.fromQueue(requests),
        updateCommits: Stream.fromQueue(commits),
        updateCancellations: Stream.fromQueue(cancellations),
      });

      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      yield* DesktopRemoteUpdates.listen.pipe(
        Effect.provideService(DesktopTelemetryPublisher.DesktopTelemetryPublisher, publisher),
      );
      yield* settle;
      yield* body({ reports, requests, commits, cancellations });
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
}

function terminalReports(reports: DesktopUpdateStatusReport[]): DesktopUpdateStatusReport[] {
  return reports.filter((report) => report.outcome !== undefined);
}

describe("DesktopRemoteUpdates", () => {
  it.effect("cancels an active preparation so the next request can run", () => {
    const releaseCheck = Deferred.makeUnsafe<void>();
    const harness = makeHarness({ checkForUpdates: Deferred.await(releaseCheck) });

    return runRemoteUpdatesTest(harness, ({ requests, cancellations }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-cancel"));
        yield* settle;
        yield* Queue.offer(cancellations, {
          version: 1,
          type: "cancelDesktopUpdate",
          requestId: "req-cancel",
        });
        yield* settle;
        yield* Deferred.succeed(releaseCheck, undefined);
        yield* Queue.offer(requests, request("req-next"));
        yield* settle;

        assert.equal(harness.checkCount(), 2);
      }),
    );
  });

  it.effect("remembers a cancellation that arrives before its request starts", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ requests, cancellations }) =>
      Effect.gen(function* () {
        yield* Queue.offer(cancellations, {
          version: 1,
          type: "cancelDesktopUpdate",
          requestId: "req-early-cancel",
        });
        yield* Queue.offer(requests, request("req-early-cancel"));
        yield* settle;

        assert.equal(harness.checkCount(), 0);

        yield* Queue.offer(requests, request("req-after-early-cancel"));
        yield* settle;
        assert.equal(harness.checkCount(), 1);
      }),
    );
  });

  it.effect("does not install after cancellation wins the commit claim", () => {
    const harness = makeHarness();

    return runRemoteUpdatesTest(harness, ({ reports, requests, commits, cancellations }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-cancel-before-commit"));
        yield* settle;
        harness.emit("update-available", { version: "1.2.4" });
        yield* settle;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* settle;

        yield* Queue.offer(cancellations, {
          version: 1,
          type: "cancelDesktopUpdate",
          requestId: "req-cancel-before-commit",
        });
        yield* settle;
        yield* Queue.offer(commits, {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-cancel-before-commit",
        });
        yield* settle;

        assert.equal(harness.quitAndInstalls(), 0);
        assert.deepEqual(
          terminalReports(reports)
            .filter((report) => report.requestId === "req-cancel-before-commit")
            .map((report) => report.outcome),
          ["ready-to-install", "failed"],
        );
      }),
    );
  });

  it.effect("retains an install failure after cancellation loses the commit claim", () => {
    const installStarted = Deferred.makeUnsafe<void>();
    const releaseInstall = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      quitAndInstall: Deferred.succeed(installStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseInstall)),
        Effect.andThen(
          Effect.fail(
            new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
              channel: "latest",
              isSilent: true,
              isForceRunAfter: true,
              cause: new Error("installer refused"),
            }),
          ),
        ),
      ),
    });

    return runRemoteUpdatesTest(harness, ({ reports, requests, commits, cancellations }) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request("req-cancel-after-commit"));
        yield* settle;
        harness.emit("update-available", { version: "1.2.4" });
        yield* settle;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* settle;
        const commit = {
          version: 1,
          type: "commitDesktopUpdate",
          requestId: "req-cancel-after-commit",
        } as const;
        yield* Queue.offer(commits, commit);
        yield* Deferred.await(installStarted);
        yield* Queue.offer(cancellations, {
          version: 1,
          type: "cancelDesktopUpdate",
          requestId: "req-cancel-after-commit",
        });
        yield* settle;
        yield* Deferred.succeed(releaseInstall, undefined);
        yield* settle;
        yield* Queue.offer(commits, commit);
        yield* settle;

        assert.deepEqual(
          terminalReports(reports)
            .filter((report) => report.requestId === "req-cancel-after-commit")
            .map((report) => report.outcome),
          ["ready-to-install", "failed", "failed"],
        );
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
});
