import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";

// Bridges gaps between back-to-back runs, so a long-idle machine does not sleep mid-queue.
const RELEASE_GRACE = Duration.seconds(60);
const AC_POWER_POLL_INTERVAL = Duration.seconds(30);

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by the calling thread until the script ends.
const WINDOWS_HOLD_SCRIPT = `$t = Add-Type -Name Power -Namespace T3 -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$t::SetThreadExecutionState([uint32]2147483649); [Console]::Out.WriteLine()`;

// GetSystemPowerStatus ACLineStatus: 0 = battery, 1 = AC, 255 = unknown (desktop without battery).
const WINDOWS_AC_POWER_SCRIPT = `Add-Type -Name PowerStatus -Namespace T3 -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct SPS { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public uint BatteryLifeTime; public uint BatteryFullLifeTime; } [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out SPS s); public static int ReadAcLineStatus() { SPS s; return GetSystemPowerStatus(out s) ? s.ACLineStatus : -1; }'; [Console]::Out.WriteLine([T3.PowerStatus]::ReadAcLineStatus())`;

export function parseWindowsAcLineStatus(output: string): boolean {
  const status = Number.parseInt(output.trim(), 10);
  if (Number.isNaN(status) || status < 0) return false;
  return status !== 0;
}

export function parseDarwinPowerSource(output: string): boolean {
  if (output.includes("Battery Power")) return false;
  return output.includes("AC Power");
}

export function resolveLinuxPowerSupplyAcPower(
  supplies: ReadonlyArray<{ readonly type: string; readonly online: string | undefined }>,
): boolean {
  let sawBattery = false;
  for (const supply of supplies) {
    const kind = supply.type.trim();
    if (kind === "Mains" && supply.online?.trim() === "1") {
      return true;
    }
    if (kind === "Battery") {
      sawBattery = true;
    }
  }
  return !sawBattery;
}

export function shouldHoldKeepAwake(input: {
  readonly keepAwakeWhileAgentsWork: boolean;
  readonly keepAwakeWhenPluggedIn: boolean;
  readonly hasActiveRun: boolean;
  readonly onAcPower: boolean;
}): boolean {
  return (
    (input.keepAwakeWhileAgentsWork && input.hasActiveRun) ||
    (input.keepAwakeWhenPluggedIn && input.onAcPower)
  );
}

/**
 * Each command writes a line to stdout once it holds its inhibitor, holds it until it exits, and
 * exits on its own if the server dies.
 */
function inhibitorCommand(
  platform: NodeJS.Platform,
  serverPid: number,
  isWsl: boolean,
):
  | {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly stdin: "ignore" | "pipe";
    }
  | undefined {
  // logind inside the WSL VM cannot block Windows sleep. Windows cannot wait on a Linux pid, so
  // the hold ends when its stdin pipe closes, which also happens if the server dies.
  if (isWsl) {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${WINDOWS_HOLD_SCRIPT}; [void][Console]::In.ReadToEnd()`,
      ],
      stdin: "pipe",
    };
  }
  switch (platform) {
    case "darwin":
      return {
        command: "sh",
        args: ["-c", 'echo && exec caffeinate -i -w "$0"', String(serverPid)],
        stdin: "ignore",
      };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=sleep",
          "--who=T3 Code",
          "--why=Agents are working",
          "--mode=block",
          // systemd-inhibit starts this only after logind grants the lock.
          "sh",
          "-c",
          'echo && exec tail --pid="$0" -f /dev/null',
          String(serverPid),
        ],
        stdin: "ignore",
      };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `${WINDOWS_HOLD_SCRIPT}; Wait-Process -Id ${serverPid}`,
        ],
        stdin: "ignore",
      };
    default:
      return undefined;
  }
}

/**
 * Runs `hold` while `wanted` is true and for `grace` after it turns false; a true inside the
 * grace keeps the same hold. `hold` runs until interrupted.
 */
export const holdWhileWanted = <E, R>(
  wanted: Stream.Stream<boolean, E, R>,
  hold: Effect.Effect<void>,
  grace: Duration.Input = RELEASE_GRACE,
) =>
  wanted.pipe(
    Stream.changes,
    Stream.switchMap((on) =>
      on ? Stream.succeed(true) : Stream.fromEffect(Effect.as(Effect.sleep(grace), false)),
    ),
    Stream.changes,
    Stream.switchMap((on) => (on ? Stream.fromEffect(hold) : Stream.empty)),
    Stream.runDrain,
  );

// Reads, the event subscription and the inhibitor retry until they succeed; the cap keeps a
// host without an inhibitor (e.g. no logind) from retrying and warning constantly.
const backoff = Schedule.exponential("5 seconds").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(10))),
  ),
);
const retryWithBackoff =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logWarning(message, { cause })),
      Effect.retry(backoff),
    );

class KeepAwakeInhibitorExited extends Schema.TaggedError<KeepAwakeInhibitorExited>()(
  "KeepAwakeInhibitorExited",
  { exitCode: Schema.Number, stderr: Schema.String },
) {
  override get message(): string {
    return `sleep inhibitor exited with code ${this.exitCode}${this.stderr ? `: ${this.stderr}` : ""}`;
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const fileSystem = yield* FileSystem.FileSystem;
    // Services started by systemd lack WSL_DISTRO_NAME and WSL_INTEROP; the kernel release does not.
    const isWsl =
      platform === "linux" &&
      (yield* fileSystem.readFileString("/proc/sys/kernel/osrelease").pipe(
        Effect.map((release) => release.toLowerCase().includes("microsoft")),
        Effect.orElseSucceed(() => false),
      ));
    const command = inhibitorCommand(platform, process.pid, isWsl);
    if (command === undefined) return;
    const settings = yield* Settings.ServerSettingsService;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const hasActiveRun = sql<{ readonly active: number }>`
      SELECT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs
        WHERE status IN ('preparing', 'starting', 'running')
      ) AS active
    `.pipe(
      Effect.map((rows) => rows[0]?.active === 1),
      retryWithBackoff("keep-awake could not read active runs"),
    );
    // Read the cursor before the snapshot so a run changing in between is replayed, not missed.
    const active = Stream.unwrap(
      events.latestApplicationSequence.pipe(
        retryWithBackoff("keep-awake could not read the event cursor"),
        Effect.map((afterSequence) =>
          Stream.concat(
            Stream.succeed(undefined),
            events
              .streamApplicationEvents({ afterSequence })
              .pipe(
                Stream.filter(
                  (stored) =>
                    "event" in stored &&
                    (stored.event.type === "run.created" || stored.event.type === "run.updated"),
                ),
              ),
          ),
        ),
      ),
    ).pipe(
      Stream.mapEffect(() => hasActiveRun),
      // A failed subscription resubscribes, which re-reads the cursor and the snapshot.
      Stream.tapCause((cause) =>
        Effect.logWarning("keep-awake run event stream failed", { cause }),
      ),
      Stream.retry(backoff),
    );
    const keepAwakeSettings = Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* settings.subscribeChanges;
        const pick = (value: {
          readonly keepAwakeWhileAgentsWork: boolean;
          readonly keepAwakeWhenPluggedIn: boolean;
        }) => ({
          keepAwakeWhileAgentsWork: value.keepAwakeWhileAgentsWork,
          keepAwakeWhenPluggedIn: value.keepAwakeWhenPluggedIn,
        });
        const current = yield* settings.getSettings.pipe(
          Effect.map(pick),
          Effect.orElseSucceed(() => ({
            keepAwakeWhileAgentsWork: true,
            keepAwakeWhenPluggedIn: false,
          })),
        );
        return Stream.concat(Stream.succeed(current), Stream.map(changes, pick));
      }),
    );

    const runCommandStdout = Effect.fn("keepAwake.runCommandStdout")(function* (
      command: string,
      args: ReadonlyArray<string>,
    ) {
      return yield* Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(command, args, {
            detached: false,
            shell: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          }),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: "unbounded" },
        );
        return Number(exitCode) === 0 ? stdout : "";
      }).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => ""),
      );
    });

    const probeAcPower: Effect.Effect<boolean> = Effect.gen(function* () {
      if (platform === "win32" || isWsl) {
        const stdout = yield* runCommandStdout("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          WINDOWS_AC_POWER_SCRIPT,
        ]);
        return parseWindowsAcLineStatus(stdout);
      }
      if (platform === "darwin") {
        const stdout = yield* runCommandStdout("pmset", ["-g", "ps"]);
        return parseDarwinPowerSource(stdout);
      }
      if (platform === "linux") {
        const root = "/sys/class/power_supply";
        const entries = yield* fileSystem
          .readDirectory(root)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        const supplies = yield* Effect.forEach(
          entries,
          (entry) =>
            Effect.all({
              type: fileSystem
                .readFileString(`${root}/${entry}/type`)
                .pipe(Effect.orElseSucceed(() => "")),
              online: fileSystem
                .readFileString(`${root}/${entry}/online`)
                .pipe(Effect.orElseSucceed(() => undefined)),
            }),
          { concurrency: "unbounded" },
        );
        return resolveLinuxPowerSupplyAcPower(supplies);
      }
      return false;
    });

    const pluggedInWanted = keepAwakeSettings.pipe(
      Stream.map((value) => value.keepAwakeWhenPluggedIn),
      Stream.changes,
      Stream.switchMap((on) =>
        on
          ? Stream.concat(
              Stream.fromEffect(probeAcPower),
              Stream.fromSchedule(Schedule.spaced(AC_POWER_POLL_INTERVAL)).pipe(
                Stream.mapEffect(() => probeAcPower),
              ),
            )
          : Stream.succeed(false),
      ),
    );

    const wanted = Stream.zipLatestWith(
      Stream.zipLatestWith(keepAwakeSettings, active, (currentSettings, hasActiveRun) => ({
        ...currentSettings,
        hasActiveRun,
      })),
      pluggedInWanted,
      (state, onAcPower) => shouldHoldKeepAwake({ ...state, onAcPower }),
    );

    const holdOnce = Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          detached: false,
          shell: false,
          stdin: command.stdin,
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const stderr = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.forkScoped,
      );
      const held = yield* Ref.make(false);
      yield* Effect.addFinalizer(() =>
        Effect.when(Effect.logInfo("keep-awake released sleep inhibitor"), Ref.get(held)),
      );
      yield* child.stdout.pipe(
        Stream.take(1),
        Stream.runForEach(() =>
          Ref.set(held, true).pipe(
            Effect.andThen(
              Effect.logInfo("keep-awake holding sleep inhibitor", { pid: Number(child.pid) }),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const exitCode = yield* child.exitCode;
      return yield* new KeepAwakeInhibitorExited({
        exitCode: Number(exitCode),
        stderr: (yield* Fiber.join(stderr)).trim(),
      });
    }).pipe(Effect.scoped);
    const hold = holdOnce.pipe(
      retryWithBackoff("keep-awake sleep inhibitor stopped"),
      Effect.ignore,
    );

    yield* forkParked(
      holdWhileWanted(wanted, hold).pipe(
        Effect.catchCause((cause) => Effect.logWarning("keep-awake stopped", { cause })),
      ),
    );
  }),
);
