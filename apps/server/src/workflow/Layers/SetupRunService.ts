import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerInput,
} from "../../project/ProjectSetupScriptRunner.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  SetupRunService,
  SetupTerminalPort,
  type SetupRunServiceShape,
  type SetupTerminalPortShape,
  type SetupStatus,
} from "../Services/SetupRunService.ts";

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

const toSetupError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toSetupError("setup op failed")));

interface SetupRunRow {
  readonly status: string;
  readonly exitCode: number | null;
  readonly worktreeRef: string | null;
}

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const normalizeStatus = (exitCode: number): SetupStatus =>
  exitCode === 0 ? "completed" : exitCode === -1 ? "timed_out" : "failed";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const terminal = yield* SetupTerminalPort;

  const runSetup: SetupRunServiceShape["runSetup"] = (
    ticketId,
    worktreeRef,
    worktreePath,
    setupRunId,
    projectId,
  ) =>
    Effect.gen(function* () {
      const existing = yield* wrapSql(sql<SetupRunRow>`
        SELECT
          status,
          exit_code AS "exitCode",
          worktree_ref AS "worktreeRef"
        FROM workflow_setup_run
        WHERE ticket_id = ${ticketId}
      `);
      // Only skip setup when the completed run was for the SAME worktree. The
      // worktree janitor can remove a worktree (and its lease) without clearing
      // this row; a later re-activation recreates an empty worktree with a new
      // ref, where dependencies must be installed again. Keying the skip on
      // ticket_id alone would run the next step in a dependency-less checkout.
      if (existing[0]?.status === "completed" && existing[0].worktreeRef === worktreeRef) {
        return { status: "completed", exitCode: existing[0].exitCode };
      }

      yield* wrapSql(sql`
        INSERT INTO workflow_setup_run (
          setup_run_id,
          ticket_id,
          worktree_ref,
          status,
          started_at
        )
        VALUES (${setupRunId}, ${ticketId}, ${worktreeRef}, 'running', ${yield* nowIso})
        ON CONFLICT(ticket_id) DO UPDATE SET
          setup_run_id = excluded.setup_run_id,
          worktree_ref = excluded.worktree_ref,
          status = 'running',
          started_at = excluded.started_at,
          finished_at = NULL,
          exit_code = NULL
      `);

      const { threadId: launchedThreadId, terminalId } = yield* terminal.launch({
        worktreePath,
        ...(projectId === undefined ? {} : { projectId }),
      });
      const exit =
        terminalId === null
          ? { exitCode: 0 }
          : yield* terminal
              .awaitExit({ threadId: launchedThreadId, terminalId, timeoutMs: SETUP_TIMEOUT_MS })
              .pipe(Effect.orElseSucceed(() => ({ exitCode: -1 })));
      const status = normalizeStatus(exit.exitCode);

      yield* wrapSql(sql`
        UPDATE workflow_setup_run
        SET status = ${status},
            exit_code = ${exit.exitCode},
            finished_at = ${yield* nowIso}
        WHERE ticket_id = ${ticketId}
      `);

      return { status, exitCode: exit.exitCode };
    });

  return { runSetup } satisfies SetupRunServiceShape;
});

export const SetupRunServiceLive = Layer.effect(SetupRunService, make);

const awaitTerminalExit = (
  terminals: TerminalManager["Service"],
  input: {
    readonly threadId: string;
    readonly terminalId: string | null;
    readonly timeoutMs?: number;
  },
): Effect.Effect<{ readonly exitCode: number }, WorkflowEventStoreError> => {
  const { terminalId } = input;
  if (terminalId === null) {
    return Effect.succeed({ exitCode: 0 });
  }

  return Effect.gen(function* () {
    const done = yield* Deferred.make<{ readonly exitCode: number }>();
    // Subscribe FIRST so we don't miss an exit event that races with our check.
    const unsubscribe = yield* terminals.subscribe((event) => {
      if (
        event.type !== "exited" ||
        event.terminalId !== terminalId ||
        event.threadId !== input.threadId
      ) {
        return Effect.void;
      }
      return Deferred.succeed(done, { exitCode: event.exitCode ?? 1 }).pipe(Effect.asVoid);
    });
    // THEN check current status: if the terminal already exited before we
    // subscribed, resolve the deferred immediately with its recorded exit code.
    const currentSnapshot = yield* terminals.getSnapshot({
      threadId: input.threadId,
      terminalId,
    });
    if (currentSnapshot !== null && currentSnapshot.status === "exited") {
      yield* Deferred.succeed(done, { exitCode: currentSnapshot.exitCode ?? 1 }).pipe(
        Effect.asVoid,
      );
    }
    const wait = Deferred.await(done);
    const timed =
      input.timeoutMs === undefined
        ? wait
        : wait.pipe(
            Effect.timeoutOption(Duration.millis(input.timeoutMs)),
            Effect.flatMap((result) =>
              Option.match(result, {
                onNone: () =>
                  // Setup timed out while the PTY is still running. Close it
                  // (best-effort) so the process doesn't leak past the timeout,
                  // then surface the timeout; `orElseSucceed` upstream maps this
                  // to a timed_out result.
                  terminals.close({ threadId: input.threadId, terminalId }).pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Effect.fail(
                        new WorkflowEventStoreError({
                          message: "setup terminal wait timed out",
                        }),
                      ),
                    ),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
    // The only failure `timed` can produce is the timeout branch's own
    // descriptive WorkflowEventStoreError ("setup terminal wait timed out") —
    // `Deferred.await` here never fails. Wrapping it again via `toSetupError`
    // would nest WorkflowEventStoreErrors and bury that message, so fail through
    // directly. (PR #3032 macroscope review.)
    return yield* timed.pipe(Effect.ensuring(Effect.sync(unsubscribe)));
  });
};

export const SetupTerminalPortLive = Layer.effect(
  SetupTerminalPort,
  Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner;
    const terminals = yield* TerminalManager;

    return {
      launch: (input) => {
        const setupInput = {
          threadId: input.threadId ?? `workflow-setup:${input.worktreePath}`,
          worktreePath: input.worktreePath,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
          ...(input.preferredTerminalId === undefined
            ? {}
            : { preferredTerminalId: input.preferredTerminalId }),
        } satisfies ProjectSetupScriptRunnerInput;

        return runner.runForThread(setupInput).pipe(
          Effect.map((result) =>
            result.status === "no-script"
              ? { threadId: setupInput.threadId, terminalId: null }
              : { threadId: setupInput.threadId, terminalId: result.terminalId },
          ),
          Effect.mapError(toSetupError("setup launch failed")),
        );
      },
      awaitExit: (input) => awaitTerminalExit(terminals, input),
    } satisfies SetupTerminalPortShape;
  }),
);
