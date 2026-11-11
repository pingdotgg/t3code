import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
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

/** Holds while `wanted` is true and for `grace` after it turns false; a true inside the grace keeps the same hold. */
export const holdWhileWanted = <E, R>(
  wanted: Stream.Stream<boolean, E, R>,
  hold: Effect.Effect<void, never, Scope.Scope>,
  grace: Duration.Input = RELEASE_GRACE,
) =>
  wanted.pipe(
    Stream.changes,
    Stream.switchMap((on) =>
      on ? Stream.succeed(true) : Stream.fromEffect(Effect.as(Effect.sleep(grace), false)),
    ),
    Stream.changes,
    Stream.switchMap((on) => (on ? Stream.unwrap(Effect.as(hold, Stream.never)) : Stream.empty)),
    Stream.runDrain,
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const command = inhibitorCommand(yield* HostProcess.Platform, process.pid);
    if (command === undefined) return;
    const settings = yield* Settings.ServerSettingsService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const hasActiveRun = sql<{ readonly active: number }>`
      SELECT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs
        WHERE status IN ('preparing', 'starting', 'running')
      ) AS active
    `.pipe(
      Effect.map((rows) => rows[0]?.active === 1),
      Effect.catchCause((cause) =>
        Effect.logWarning("keep-awake could not read active runs", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );
    const active = Stream.concat(
      Stream.fromEffect(hasActiveRun),
      engine.streamDomainEvents.pipe(
        Stream.filter((event) => event.type === "run.created" || event.type === "run.updated"),
        Stream.mapEffect(() => hasActiveRun),
      ),
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

    const hold = spawner
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
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("keep-awake could not start the sleep inhibitor", {
            command: command.command,
            cause,
          }),
        ),
      );

    yield* forkParked(
      holdWhileWanted(
        Stream.zipLatestWith(enabled, active, (on, busy) => on && busy),
        hold,
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("keep-awake stopped", { cause }))),
    );
  }),
);
