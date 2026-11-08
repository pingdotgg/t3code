import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

const WINDOWS_ES_CONTINUOUS_SYSTEM_REQUIRED = 0x80000001;

/**
 * Each command holds a system sleep lock until it is killed. Each also watches the server's pid,
 * so a server that is killed outright cannot leave the host unable to sleep.
 */
function wakeLockCommand(platform: NodeJS.Platform, serverPid: number) {
  switch (platform) {
    case "darwin":
      return { command: "/usr/bin/caffeinate", args: ["-i", "-w", `${serverPid}`] };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          "--who=T3 Code",
          "--why=Keeping this machine awake for coding agents",
          "--mode=block",
          "tail",
          `--pid=${serverPid}`,
          "-f",
          "/dev/null",
        ],
      };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          `$k = Add-Type -Name WakeLock -Namespace T3 -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; [void]$k::SetThreadExecutionState(${WINDOWS_ES_CONTINUOUS_SYSTEM_REQUIRED}); Wait-Process -Id ${serverPid}`,
        ],
      };
    default:
      return null;
  }
}

/** Holds a host sleep lock according to the `keepHostAwake` setting. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const shouldHold = Effect.gen(function* () {
    const { keepHostAwake } = yield* settings.getSettings;
    return keepHostAwake === "whileWorking"
      ? yield* projections.hasWorkingRuns()
      : keepHostAwake === "always";
  });

  const start = Effect.fn("HostWakeLock.start")(function* () {
    const wakeLock = wakeLockCommand(yield* HostProcess.Platform, process.pid);
    if (wakeLock === null) return;

    const hold = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(wakeLock.command, wakeLock.args, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "2 seconds",
          }),
        );
        const exitCode = yield* handle.exitCode;
        yield* Effect.logWarning("host wake lock exited early", { exitCode });
      }),
    ).pipe(
      Effect.catch((cause) => Effect.logWarning("host wake lock unavailable", { cause })),
      // Node throws some spawn errors synchronously, which `catch` cannot see.
      Effect.catchDefect((cause) => Effect.logWarning("host wake lock unavailable", { cause })),
    );

    const lock = yield* FiberHandle.make<void>();
    const reconcile = shouldHold.pipe(
      Effect.flatMap((held) =>
        held
          ? FiberHandle.run(lock, hold, { onlyIfMissing: true }).pipe(Effect.asVoid)
          : FiberHandle.clear(lock),
      ),
      Effect.catch((cause) => Effect.logWarning("host wake lock update failed", { cause })),
    );

    const settingsChanges = yield* settings.subscribeChanges;
    yield* forkParked(
      Stream.succeed(undefined).pipe(
        Stream.merge(
          settingsChanges.pipe(
            Stream.map((current) => current.keepHostAwake),
            Stream.changes,
          ),
        ),
        Stream.merge(
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.created" ||
                event.type === "run.updated" ||
                // Background agents can outlive their parent run; their roster lives here.
                event.type === "provider-thread.updated",
            ),
          ),
        ),
        Stream.runForEach(() => reconcile),
      ),
    );
  });

  return { start };
});
