import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { windowsPowerShellPath } from "@t3tools/shared/windowsSystem";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";

// Bridges gaps between back-to-back runs, so a long-idle machine does not sleep mid-queue.
const RELEASE_GRACE = Duration.seconds(60);

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by the calling thread until the script ends.
const WINDOWS_HOLD_SCRIPT = `$t = Add-Type -Name Power -Namespace T3 -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void]$t::SetThreadExecutionState([uint32]2147483649); [Console]::Out.WriteLine()`;

/**
 * Each command writes a line to stdout once it holds its inhibitor, holds it until it exits, and
 * exits on its own if the server dies.
 */
export function inhibitorCommand(
  platform: NodeJS.Platform,
  serverPid: number,
  isWsl: boolean,
  env: NodeJS.ProcessEnv,
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
        command: windowsPowerShellPath(env),
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

// Every event that can change what hasActiveWork reads.
const TRIGGER_EVENT_TYPES = new Set<OrchestrationV2DomainEvent["type"]>([
  "run.created",
  "run.updated",
  "subagent.updated",
  "provider-thread.updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.provider-switched",
]);

const decodePendingTasksPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      pendingBackgroundTasks: Schema.optional(Schema.Array(OrchestrationV2PendingBackgroundTask)),
    }),
  ),
);

/**
 * Active local work: non-waiting runs, active provider-native subagents (app-owned children hold
 * via their own runs or run remotely), and awaited provider background tasks (not dev servers).
 */
export const hasActiveWork = Effect.fn("KeepAwake.hasActiveWork")(function* (
  sql: SqlClient.SqlClient,
) {
  const activeRows = yield* sql<{ readonly active: number }>`
    SELECT (
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs
        WHERE status IN ('preparing', 'starting', 'running')
      )
      OR EXISTS (
        SELECT 1
        FROM orchestration_v2_projection_subagents AS subagent
        JOIN orchestration_v2_projection_threads AS thread
          ON thread.thread_id = subagent.thread_id
        WHERE subagent.origin = 'provider_native'
          AND subagent.status IN ('pending', 'running')
          AND thread.deleted_at IS NULL
          AND thread.archived_at IS NULL
      )
    ) AS active
  `;
  if (activeRows[0]?.active === 1) return true;

  // The pendingBackgroundTasks condition matches migration 098's partial index; keep them identical.
  const providerThreadRows = yield* sql<{ readonly payload_json: string }>`
    SELECT pt.payload_json
    FROM orchestration_v2_projection_provider_threads AS pt
    JOIN orchestration_v2_projection_threads AS thread
      ON thread.thread_id = pt.thread_id
    WHERE CASE WHEN json_valid(pt.payload_json)
        THEN json_array_length(pt.payload_json, '$.pendingBackgroundTasks') > 0
        ELSE 0 END
      AND thread.deleted_at IS NULL
      AND thread.archived_at IS NULL
      AND (
        thread.active_provider_thread_id IS NULL
        OR thread.active_provider_thread_id = pt.provider_thread_id
      )
  `;
  return providerThreadRows.some((row) => {
    const parsed = decodePendingTasksPayload(row.payload_json);
    return (
      Option.isSome(parsed) &&
      backgroundWorkHoldsCompletion(parsed.value.pendingBackgroundTasks ?? [])
    );
  });
});

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
    const command = inhibitorCommand(platform, process.pid, isWsl, yield* HostProcess.Environment);
    if (command === undefined) return;
    const settings = yield* Settings.ServerSettingsService;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkActiveWork = hasActiveWork(sql).pipe(
      retryWithBackoff("keep-awake could not read active work"),
    );
    // Read the cursor before the snapshot so work changing in between is replayed, not missed.
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
                  (stored) => "event" in stored && TRIGGER_EVENT_TYPES.has(stored.event.type),
                ),
              ),
          ),
        ),
      ),
    ).pipe(
      Stream.mapEffect(() => checkActiveWork),
      // A failed subscription resubscribes, which re-reads the cursor and the snapshot.
      Stream.tapCause((cause) => Effect.logWarning("keep-awake event stream failed", { cause })),
      Stream.retry(backoff),
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
      holdWhileWanted(
        Stream.zipLatestWith(enabled, active, (on, busy) => on && busy),
        hold,
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("keep-awake stopped", { cause }))),
    );
  }),
);
