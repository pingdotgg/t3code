import type {
  ResourceTelemetryProcessCategory,
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessSignal,
  ServerSignalProcessResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";

export interface ProcessDiagnosticsShape {
  readonly read: Effect.Effect<ServerProcessDiagnosticsResult>;
  readonly signal: (input: {
    readonly pid: number;
    readonly startTimeMs: number;
    readonly signal: ServerProcessSignal;
  }) => Effect.Effect<ServerSignalProcessResult>;
}

export class ProcessDiagnostics extends Context.Service<
  ProcessDiagnostics,
  ProcessDiagnosticsShape
>()("t3/diagnostics/ProcessDiagnostics") {}

export class ProcessIdentityChanged extends Schema.TaggedErrorClass<ProcessIdentityChanged>()(
  "ProcessIdentityChanged",
  {
    pid: Schema.Number,
    startTimeMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${this.pid} no longer matches start time ${this.startTimeMs}.`;
  }
}

export class ProcessSignalFailed extends Schema.TaggedErrorClass<ProcessSignalFailed>()(
  "ProcessSignalFailed",
  {
    pid: Schema.Number,
    signal: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to signal process ${this.pid} with ${this.signal}.`;
  }
}

export type ProcessDiagnosticsError = ProcessIdentityChanged | ProcessSignalFailed;

function formatElapsed(runTimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(runTimeMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function canSignalCategory(category: ResourceTelemetryProcessCategory): boolean {
  return (
    category === "server-child" || category === "provider-root" || category === "terminal-root"
  );
}

export const make = Effect.fn("makeProcessDiagnostics")(function* () {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const read: ProcessDiagnosticsShape["read"] = telemetry.latest.pipe(
    Effect.map((snapshot) => {
      const processes = snapshot.processes
        .filter((entry) => entry.identity.pid !== process.pid)
        .map(
          (entry): ServerProcessDiagnosticsEntry => ({
            pid: entry.identity.pid,
            startTimeMs: entry.identity.startTimeMs,
            ppid: entry.ppid,
            pgid: Option.none(),
            status: entry.status || "Unknown",
            cpuPercent: entry.cpuPercent,
            rssBytes: entry.residentBytes,
            elapsed: formatElapsed(entry.runTimeMs),
            command: entry.command || entry.name || "unknown",
            depth: Math.max(0, entry.depth - 1),
            childPids: entry.childPids,
          }),
        );
      return {
        serverPid: process.pid,
        readAt: snapshot.readAt,
        processCount: processes.length,
        totalRssBytes: processes.reduce((total, entry) => total + entry.rssBytes, 0),
        totalCpuPercent: processes.reduce((total, entry) => total + entry.cpuPercent, 0),
        processes,
        error: Option.map(snapshot.health.native.lastError, (message) => ({ message })),
      };
    }),
  );

  const signal: ProcessDiagnosticsShape["signal"] = Effect.fn("ProcessDiagnostics.signal")(
    function* (input) {
      if (input.pid === process.pid) {
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some("Refusing to signal the T3 server process."),
        };
      }
      const current = yield* telemetry.latest;
      const selected = current.processes.find(
        (entry) =>
          entry.identity.pid === input.pid && entry.identity.startTimeMs === input.startTimeMs,
      );
      if (!selected) {
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some(
            `Process ${input.pid} no longer matches the selected process identity.`,
          ),
        };
      }
      if (!canSignalCategory(selected.category)) {
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some(`Process ${input.pid} is not a signalable T3 backend descendant.`),
        };
      }
      return yield* telemetry
        .validateProcessIdentity({
          pid: input.pid,
          startTimeMs: input.startTimeMs,
        })
        .pipe(
          Effect.flatMap((valid) =>
            valid
              ? Effect.void
              : Effect.fail(
                  new ProcessIdentityChanged({
                    pid: input.pid,
                    startTimeMs: input.startTimeMs,
                  }),
                ),
          ),
          Effect.flatMap(() =>
            Effect.try({
              try: () => {
                process.kill(input.pid, input.signal);
                return {
                  pid: input.pid,
                  signal: input.signal,
                  signaled: true,
                  message: Option.none(),
                };
              },
              catch: (cause) =>
                new ProcessSignalFailed({
                  pid: input.pid,
                  signal: input.signal,
                  cause,
                }),
            }),
          ),
          Effect.catch((error) =>
            Effect.succeed({
              pid: input.pid,
              signal: input.signal,
              signaled: false,
              message: Option.some(
                error instanceof Error ? error.message : "Failed to signal process.",
              ),
            }),
          ),
        );
    },
  );

  return ProcessDiagnostics.of({ read, signal });
});

export const layer = Layer.effect(ProcessDiagnostics, make());
