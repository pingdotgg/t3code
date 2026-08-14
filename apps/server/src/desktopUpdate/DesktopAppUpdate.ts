// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  ServerSelfUpdateError,
  type DesktopUpdateState,
  type DesktopUpdateStatusReport,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

/** Backstop for a desktop updater that hangs without ever reporting a
    terminal outcome. Generous: it covers a slow download of a full build. */
const DESKTOP_UPDATE_TIMEOUT = Duration.minutes(20);

/** Progress stage a desktop update state maps to, or null when the state
    carries no progress worth streaming. */
export function desktopUpdateProgressStage(
  state: DesktopUpdateState,
): ServerSelfUpdateProgressStage | null {
  switch (state.status) {
    case "checking":
    case "available":
    case "downloading":
      return "downloading";
    case "downloaded":
      return "installing";
    default:
      return null;
  }
}

export class DesktopAppUpdate extends Context.Service<
  DesktopAppUpdate,
  {
    /** True when this server was spawned by a desktop app that can be
        driven over the telemetry control channel. */
    readonly available: boolean;
    /** Drives the desktop app's check -> download -> quit-and-install flow
        and translates its status reports into self-update progress. On
        success the desktop app is about to stop this server and relaunch. */
    readonly run: (
      reportProgress: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
  }
>()("t3/desktopUpdate/DesktopAppUpdate") {}

export const make = Effect.fn("desktopUpdate.desktopAppUpdate.make")(function* () {
  const config = yield* ServerConfig;
  const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
  const inFlight = yield* Ref.make(false);

  const available = config.mode === "desktop" && config.desktopTelemetryControlFd !== undefined;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const consumeReports = (
    requestId: string,
    changes: Stream.Stream<DesktopUpdateStatusReport>,
    reportProgress: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const lastStage = yield* Ref.make<ServerSelfUpdateProgressStage | null>(null);
      const emitStage = (stage: ServerSelfUpdateProgressStage | null): Effect.Effect<void> =>
        stage === null
          ? Effect.void
          : Ref.get(lastStage).pipe(
              Effect.flatMap((previous) =>
                previous === stage
                  ? Effect.void
                  : Ref.set(lastStage, stage).pipe(Effect.andThen(reportProgress(stage))),
              ),
            );

      const terminal = yield* changes.pipe(
        Stream.filter((report) => report.requestId === requestId),
        Stream.mapEffect(
          (report): Effect.Effect<Option.Option<DesktopUpdateStatusReport>> =>
            report.outcome === undefined
              ? emitStage(desktopUpdateProgressStage(report.state)).pipe(
                  Effect.as(Option.none<DesktopUpdateStatusReport>()),
                )
              : Effect.succeed(Option.some(report)),
        ),
        Stream.filterMap(
          Option.match({
            onNone: () => Result.failVoid,
            onSome: Result.succeed,
          }),
        ),
        Stream.runHead,
      );
      if (Option.isNone(terminal)) {
        return yield* failWith("The desktop app stopped reporting its update.");
      }

      const report = terminal.value;
      if (report.outcome === "installing") {
        yield* emitStage("installing");
        const targetVersion =
          report.state.downloadedVersion ??
          report.state.availableVersion ??
          report.state.currentVersion;
        yield* Effect.logInfo("Desktop app update installing; the app will relaunch this server.", {
          targetVersion,
        });
        // If the app really is relaunching, this process stops moments
        // later and the flag never matters. If the desktop rejected the
        // install after reporting (app already quitting), clearing it lets
        // the user retry instead of wedging this server until restart.
        yield* Ref.set(inFlight, false);
        return { targetVersion, method: "desktop-app" as const };
      }
      if (report.outcome === "up-to-date") {
        return yield* failWith(
          `The T3 Code desktop app on this machine is already up to date on ${report.state.currentVersion}.`,
        );
      }
      return yield* failWith(
        report.reason ?? report.state.message ?? "The desktop app update failed.",
      );
    });

  const run: DesktopAppUpdate["Service"]["run"] = Effect.fn("desktopUpdate.desktopAppUpdate.run")(
    function* (reportProgress) {
      if (!available) {
        return yield* failWith(
          "This server was not started by the T3 Code desktop app, so it cannot drive a desktop update.",
        );
      }
      if (yield* Ref.getAndSet(inFlight, true)) {
        return yield* failWith("A desktop app update is already in progress.");
      }

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const requestId = NodeCrypto.randomUUID();
          // Subscribe before sending the request so a fast first report
          // cannot be missed.
          const { changes } = yield* receiver.desktopUpdates;
          yield* receiver
            .requestDesktopUpdate(requestId)
            .pipe(
              Effect.mapError((error) =>
                failWith("Could not reach the T3 Code desktop app on this machine.", error),
              ),
            );
          return yield* consumeReports(requestId, changes, reportProgress);
        }),
      ).pipe(
        Effect.timeout(DESKTOP_UPDATE_TIMEOUT),
        Effect.catchTags({
          TimeoutError: () => failWith("The desktop app did not finish the update in time."),
        }),
        Effect.onError(() => Ref.set(inFlight, false)),
      );
    },
  );

  return DesktopAppUpdate.of({ available, run });
});

export const layer = Layer.effect(DesktopAppUpdate, make());
