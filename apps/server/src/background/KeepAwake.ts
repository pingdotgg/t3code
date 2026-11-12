import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

/** Each command holds its inhibitor until it exits, and exits on its own if the server dies. */
function inhibitorCommand(
  platform: NodeJS.Platform,
  serverPid: number,
): { readonly command: string; readonly args: ReadonlyArray<string> } | undefined {
  switch (platform) {
    case "darwin":
      return { command: "caffeinate", args: ["-i", "-w", String(serverPid)] };
    case "linux":
      return {
        command: "systemd-inhibit",
        args: [
          "--what=idle:sleep",
          "--who=T3 Code",
          "--why=Agents are working",
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
          "-Command",
          // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this thread until Wait-Process returns.
          `$t = Add-Type -Name Power -Namespace T3 -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$t::SetThreadExecutionState([uint32]2147483649); Wait-Process -Id ${serverPid}`,
        ],
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

class KeepAwakeInhibitorExited extends Schema.TaggedError<KeepAwakeInhibitorExited>()(
  "KeepAwakeInhibitorExited",
  { exitCode: Schema.Number },
) {}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const command = inhibitorCommand(yield* HostProcess.Platform, process.pid);
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
      Effect.map((rows) => [rows[0]?.active === 1]),
      // A failed read keeps the last known state rather than guessing.
      Effect.catchCause((cause) =>
        Effect.logWarning("keep-awake could not read active runs", { cause }).pipe(Effect.as([])),
      ),
    );
    // Read the cursor before the snapshot so a run changing in between is replayed, not missed.
    const active = Stream.unwrap(
      events.latestApplicationSequence.pipe(
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
      Stream.flattenIterable,
    );
    const enabled = Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* settings.subscribeChanges;
        const current = yield* settings.getSettings.pipe(
          Effect.map((value) => value.keepAwakeWhileAgentsWork),
          Effect.orElseSucceed(() => true),
        );
        return Stream.concat(
          Stream.succeed(current),
          Stream.map(changes, (value) => value.keepAwakeWhileAgentsWork),
        );
      }),
    );

    const holdOnce = spawner
      .spawn(
        ChildProcess.make(command.command, command.args, {
          detached: false,
          shell: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.tap((child) =>
          Effect.logInfo("keep-awake holding sleep inhibitor", { pid: Number(child.pid) }),
        ),
        Effect.tap(() =>
          Effect.addFinalizer(() => Effect.logInfo("keep-awake released sleep inhibitor")),
        ),
        Effect.flatMap((child) => child.exitCode),
        Effect.flatMap((exitCode) =>
          Effect.fail(new KeepAwakeInhibitorExited({ exitCode: Number(exitCode) })),
        ),
        Effect.scoped,
      );
    // An inhibitor that dies while agents still work is restarted; on hosts without one
    // (e.g. no logind) the backoff keeps retries and warnings rare.
    const hold = holdOnce.pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("keep-awake sleep inhibitor stopped", {
          command: command.command,
          cause,
        }),
      ),
      Effect.retry(
        Schedule.exponential("5 seconds").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.minutes(10))),
          ),
        ),
      ),
      Effect.ignore,
    );

    yield* forkParked(
      holdWhileWanted(
        Stream.zipLatestWith(enabled, active, (on, busy) => on && busy),
        hold,
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("keep-awake stopped", { cause }))),
    );
  }),
);
