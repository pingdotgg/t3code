import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { makeComponentLogger } from "../app/DesktopObservability.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-shipit");

const LAUNCHCTL = "/bin/launchctl";
const SHIPIT_EXIT_GRACE = "2 seconds";

const BUNDLE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,198}[A-Za-z0-9])?$/u;
const TOP_LEVEL_FIELD = /^\t([^\t=]+?) = (.*)$/u;

interface ShipItJobSnapshot {
  readonly state: string | undefined;
  readonly pid: number | "present" | undefined;
  readonly lastExitCode: number | undefined;
  readonly activeCount: number | undefined;
  readonly runs: number | undefined;
}

interface LaunchctlOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

interface IdleShipItJobInput {
  readonly platform: NodeJS.Platform;
  readonly bundleId: string;
}

function shipItLaunchdLabel(bundleId: string): string | undefined {
  if (!BUNDLE_ID.test(bundleId)) return undefined;
  return `${bundleId}.ShipIt`;
}

function launchdGuiUserId(uid: number | undefined): number | undefined {
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) return undefined;
  return uid;
}

function readInteger(value: string): number | undefined {
  if (!/^-?\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function readShipItJobSnapshot(output: string): ShipItJobSnapshot {
  let state: string | undefined;
  let pid: number | "present" | undefined;
  let lastExitCode: number | undefined;
  let activeCount: number | undefined;
  let runs: number | undefined;
  for (const line of output.split("\n")) {
    const match = TOP_LEVEL_FIELD.exec(line.replace(/\r$/u, ""));
    if (match === null) continue;
    const key = match[1];
    const value = match[2]?.trim() ?? "";
    if (key === "state" && state === undefined) state = value;
    else if (key === "pid" && pid === undefined) pid = readInteger(value) ?? "present";
    else if (key === "last exit code" && lastExitCode === undefined)
      lastExitCode = readInteger(value);
    else if (key === "active count" && activeCount === undefined) activeCount = readInteger(value);
    else if (key === "runs" && runs === undefined) runs = readInteger(value);
  }
  return { state, pid, lastExitCode, activeCount, runs };
}

// Squirrel keeps this job loaded after exit 0. A non-zero exit is a retry
// (KeepAlive SuccessfulExit = false), and a pid means ShipIt is still installing.
function shouldRemoveIdleShipItJob(snapshot: ShipItJobSnapshot): boolean {
  return (
    snapshot.state === "not running" &&
    snapshot.pid === undefined &&
    snapshot.lastExitCode === 0 &&
    snapshot.activeCount === 0 &&
    snapshot.runs !== undefined &&
    snapshot.runs > 0
  );
}

function shipItProcessIsAlive(snapshot: ShipItJobSnapshot): boolean {
  return (
    snapshot.pid !== undefined || snapshot.state === "running" || snapshot.state === "xpcproxy"
  );
}

const runLaunchctl = Effect.fn("desktop.shipIt.launchctl")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(LAUNCHCTL, args, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          child.stderr.pipe(Stream.decodeText(), Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: 3 },
      );
      return { exitCode: Number(exitCode), stdout } satisfies LaunchctlOutput;
    }),
  ).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.orElseSucceed(() => Option.none()),
  );
});

const inspectShipItJob = Effect.fn("desktop.shipIt.inspect")(function* (service: string) {
  const inspected = yield* runLaunchctl(["print", service]);
  if (Option.isNone(inspected)) return { _tag: "unread" } as const;
  if (inspected.value.exitCode !== 0) return { _tag: "absent" } as const;
  return {
    _tag: "present" as const,
    snapshot: readShipItJobSnapshot(inspected.value.stdout),
  };
});

const watchShipItExit = Effect.fn("desktop.shipIt.watchExit")(function* (service: string) {
  const first = yield* inspectShipItJob(service);
  if (first._tag !== "present" || !shipItProcessIsAlive(first.snapshot)) return first;
  // Relaunch ShipIt stays in waitpid until NSWorkspace returns, which can be
  // after whenReady. Still alive after the grace means it is waiting for us to quit.
  yield* Effect.sleep(SHIPIT_EXIT_GRACE);
  return yield* inspectShipItJob(service);
});

/** Drops Squirrel's leftover ShipIt launchd job so macOS does not keep the app "running in background" after quit. */
export const releaseIdleShipItJob = Effect.fn("desktop.shipIt.releaseIdle")(function* (
  input: IdleShipItJobInput,
) {
  if (input.platform !== "darwin") return;
  const label = shipItLaunchdLabel(input.bundleId);
  const uid = launchdGuiUserId(yield* HostProcess.UserId);
  if (label === undefined || uid === undefined) return;

  const service = `gui/${uid}/${label}`;
  const inspection = yield* watchShipItExit(service);
  if (inspection._tag === "unread") {
    yield* logWarning("could not inspect the ShipIt launchd job", { label });
    return;
  }
  if (inspection._tag === "absent") return;

  const snapshot = inspection.snapshot;
  if (!shouldRemoveIdleShipItJob(snapshot)) {
    if (snapshot.state === undefined) {
      yield* logWarning("could not read the ShipIt launchd job state; left it loaded", { label });
      return;
    }
    yield* logInfo("left ShipIt launchd job loaded", {
      label,
      state: snapshot.state,
      ...(snapshot.pid !== undefined ? { pid: snapshot.pid } : {}),
      ...(snapshot.lastExitCode !== undefined ? { lastExitCode: snapshot.lastExitCode } : {}),
      ...(snapshot.activeCount !== undefined ? { activeCount: snapshot.activeCount } : {}),
      ...(snapshot.runs !== undefined ? { runs: snapshot.runs } : {}),
    });
    return;
  }

  // SMJobSubmit registers ShipIt where `launchctl remove` unloads it.
  const removed = yield* runLaunchctl(["remove", label]);
  if (Option.isNone(removed) || removed.value.exitCode !== 0) {
    yield* logWarning("could not drop the idle ShipIt launchd job", { label });
    return;
  }
  yield* logInfo("dropped idle ShipIt launchd job", { label });
});
