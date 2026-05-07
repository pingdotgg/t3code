import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type {
  BackendTimeoutError,
  BackendProcessOutputStream,
  DesktopBackendStartConfig,
} from "./DesktopBackendManager.ts";
import { DesktopBackendOutputLog } from "./DesktopLogging.ts";
import * as DesktopRun from "./DesktopRun.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export interface DesktopBackendEventsShape {
  readonly onStarting: Effect.Effect<void>;
  readonly onStarted: (input: {
    readonly pid: number;
    readonly config: DesktopBackendStartConfig;
  }) => Effect.Effect<void>;
  readonly onReady: Effect.Effect<void>;
  readonly onReadinessFailure: (error: BackendTimeoutError) => Effect.Effect<void>;
  readonly onOutput: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void>;
  readonly onExit: (input: {
    readonly pid: Option.Option<number>;
    readonly reason: string;
  }) => Effect.Effect<void>;
  readonly onRestartScheduled: (input: {
    readonly reason: string;
    readonly delay: Duration.Duration;
  }) => Effect.Effect<void>;
}

export class DesktopBackendEvents extends Context.Service<
  DesktopBackendEvents,
  DesktopBackendEventsShape
>()("t3/desktop/BackendEvents") {}

const make = Effect.gen(function* () {
  const backendOutputLog = yield* DesktopBackendOutputLog;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const run = yield* DesktopRun.DesktopRun;
  const state = yield* DesktopState.DesktopState;

  return DesktopBackendEvents.of({
    onStarting: Ref.set(state.backendReady, false),
    onStarted: ({ pid, config }) =>
      Effect.gen(function* () {
        const runId = yield* run.id;
        yield* backendOutputLog.writeSessionBoundary({
          phase: "START",
          runId,
          details: `pid=${pid} port=${config.bootstrap.port} cwd=${config.cwd}`,
        });
      }),
    onReady: desktopWindow.handleBackendReady.pipe(
      Effect.catch((error) =>
        run.logError("failed to open main window after backend readiness", {
          message: error.message,
        }),
      ),
    ),
    onReadinessFailure: (error) =>
      run.logWarning("backend readiness check failed during bootstrap", { error: error.message }),
    onOutput: (streamName, chunk) => backendOutputLog.writeOutputChunk(streamName, chunk),
    onExit: ({ pid, reason }) =>
      Effect.gen(function* () {
        yield* Option.match(pid, {
          onNone: () => Effect.void,
          onSome: (value) =>
            Effect.gen(function* () {
              const runId = yield* run.id;
              yield* backendOutputLog.writeSessionBoundary({
                phase: "END",
                runId,
                details: `pid=${value} ${reason}`,
              });
            }),
        });
        yield* Ref.set(state.backendReady, false);
      }),
    onRestartScheduled: ({ reason, delay }) =>
      run.logError("backend exited unexpectedly; restart scheduled", {
        reason,
        delayMs: Duration.toMillis(delay),
      }),
  });
});

export const layer = Layer.effect(DesktopBackendEvents, make);
