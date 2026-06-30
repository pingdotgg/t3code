import { assert, it } from "@effect/vitest";
import type { TerminalEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { ProviderTurnPort } from "../Services/ProviderDispatchOutbox.ts";
import { ProjectScriptTrust } from "../Services/ProjectScriptTrust.ts";
import { SetupTerminalPort } from "../Services/SetupRunService.ts";
import { TicketCheckpointService } from "../Services/TicketCheckpointService.ts";
import { MergeGitPort } from "../Services/TicketMergeService.ts";
import { TicketPullRequestService } from "../Services/TicketPullRequestService.ts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { WorktreePort } from "../Services/WorktreePort.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowRecovery } from "../Services/WorkflowRecovery.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { MockAcpProvider, MockAcpProviderLive } from "./MockAcpProvider.ts";
import { WorkflowRuntimeCoreLive } from "../WorkflowRuntimeLive.ts";

const definition = {
  name: "runtime-wf",
  lanes: [
    {
      key: "code",
      name: "Code",
      entry: "auto",
      pipeline: [
        {
          key: "code-step",
          type: "agent",
          agent: { instance: "codex", model: "gpt-5.5" },
          instruction: "Write the code",
        },
      ],
      on: { success: "review", failure: "code" },
    },
    {
      key: "review",
      name: "Review",
      entry: "auto",
      pipeline: [
        {
          key: "review-step",
          type: "agent",
          agent: { instance: "codex", model: "gpt-5.5" },
          instruction: "Review the code",
        },
      ],
      on: { success: "done", failure: "code" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const smartRoutingDefinition = {
  name: "smart-routing-runtime-wf",
  lanes: [
    {
      key: "impl",
      name: "Implement",
      entry: "auto",
      pipeline: [
        {
          key: "tests",
          type: "script",
          run: "pnpm test",
          allowFailure: true,
        },
        {
          key: "review",
          type: "agent",
          agent: { instance: "codex", model: "gpt-5.5" },
          instruction: "Review the test result",
          captureOutput: true,
        },
      ],
      transitions: [
        {
          when: {
            and: [
              { "!=": [{ var: "steps.tests.exitCode" }, 0] },
              { "==": [{ var: "steps.review.output.verdict" }, "block"] },
            ],
          },
          to: "needs",
        },
      ],
      on: { success: "done" },
    },
    { key: "needs", name: "Needs Attention", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const wipDrainDefinition = {
  name: "wip-runtime-wf",
  lanes: [
    {
      key: "build",
      name: "Build",
      entry: "auto",
      wipLimit: 1,
      pipeline: [
        {
          key: "build-step",
          type: "agent",
          agent: { instance: "codex", model: "gpt-5.5" },
          instruction: "Build the ticket",
        },
      ],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const terminalManagerLayer = (scriptExitCode: number) =>
  Layer.effect(
    TerminalManager,
    Effect.gen(function* () {
      const listeners = yield* Ref.make<
        ReadonlyArray<(event: TerminalEvent) => Effect.Effect<void>>
      >([]);

      return TerminalManager.of({
        open: (input) =>
          Effect.succeed({
            threadId: input.threadId,
            terminalId: input.terminalId,
            cwd: input.cwd,
            status: "running",
          } as never),
        attachStream: () => Effect.die("unused terminal.attachStream"),
        attachHistoryStream: () => Effect.die("unused terminal.attachHistoryStream"),
        write: (input) =>
          Ref.get(listeners).pipe(
            Effect.flatMap((current) =>
              Effect.forEach(
                current,
                (listener) =>
                  listener({
                    type: "exited",
                    threadId: input.threadId,
                    terminalId: input.terminalId,
                    exitCode: scriptExitCode,
                    exitSignal: null,
                  } as never),
                { discard: true },
              ),
            ),
          ),
        resize: () => Effect.void,
        clear: () => Effect.void,
        restart: () => Effect.die("unused terminal.restart"),
        close: () => Effect.void,
        getSnapshot: () => Effect.succeed(null),
        subscribe: (listener) =>
          Ref.update(listeners, (current) => [...current, listener as never]).pipe(
            Effect.as(() => undefined),
          ),
        subscribeMetadata: () => Effect.succeed(() => undefined),
      });
    }),
  );

const makeRuntimeLayer = (scriptExitCode: number) =>
  WorkflowRuntimeCoreLive.pipe(
    Layer.provideMerge(MockAcpProviderLive),
    Layer.provideMerge(terminalManagerLayer(scriptExitCode)),
    Layer.provideMerge(
      Layer.succeed(SetupTerminalPort, {
        launch: () => Effect.succeed({ threadId: "workflow-setup:stub", terminalId: null }),
        awaitExit: () => Effect.succeed({ exitCode: 0 }),
      }),
    ),
    Layer.provideMerge(
      Layer.effect(
        WorktreePort,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return WorktreePort.of({
            ensureWorktree: (ticketId) =>
              Effect.gen(function* () {
                const worktreePath = yield* fileSystem
                  .makeTempDirectory({
                    prefix: `t3-runtime-${ticketId}-`,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new WorkflowEventStoreError({
                          message: "test worktree tempdir failed",
                          cause,
                        }),
                    ),
                  );
                return {
                  repoRoot: worktreePath,
                  worktreeRef: `wt-${ticketId}`,
                  path: worktreePath,
                };
              }),
          });
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(MergeGitPort, {
        run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TicketPullRequestService, {
        open: () => Effect.succeed({ _tag: "completed" }),
        land: () => Effect.succeed({ _tag: "completed" }),
      }),
    ),
    // The real GitHubPortLive is wired into the executor; these tests never run
    // PR steps, so stub its source-control deps to keep the layer self-contained.
    Layer.provideMerge(Layer.succeed(GitHubCli, {} as never)),
    Layer.provideMerge(Layer.succeed(SourceControlProviderRegistry, {} as never)),
    Layer.provideMerge(
      Layer.succeed(TicketCheckpointService, {
        hasBaseline: () => Effect.succeed(false),
        captureBaseline: (ticketId) => Effect.succeed(`refs/t3/tickets/${ticketId}/base` as string),
        captureStep: (ticketId, stepRunId, _cwd, kind) =>
          Effect.succeed(`refs/t3/tickets/${ticketId}/steps/${stepRunId}/${kind}` as string),
      }),
    ),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const runtimeLayer = it.layer(makeRuntimeLayer(0));
const smartRoutingLayer = it.layer(makeRuntimeLayer(1));

const advanceRuntime = Effect.gen(function* () {
  yield* TestClock.adjust("500 millis");
  yield* Effect.yieldNow;
});

const waitFor = <E>(predicate: Effect.Effect<boolean, E>, label: string): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (yield* predicate) {
        return;
      }
      yield* advanceRuntime;
    }
    assert.fail(`Timed out waiting for ${label}`);
  });

const waitForDetail = (
  read: WorkflowReadModel["Service"],
  ticketId: string,
  predicate: (detail: TicketDetail | null) => boolean,
  label: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const detail = yield* read.getTicketDetail(ticketId as never);
      if (predicate(detail)) {
        return detail;
      }
      yield* advanceRuntime;
    }
    assert.fail(`Timed out waiting for ${label}`);
  });

const waitForDispatchForTicket = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = yield* sql<{ readonly threadId: string; readonly turnId: string | null }>`
        SELECT thread_id AS "threadId", turn_id AS "turnId"
        FROM workflow_dispatch_outbox
        WHERE ticket_id = ${ticketId}
          AND turn_id IS NOT NULL
        ORDER BY created_at DESC, dispatch_id DESC
        LIMIT 1
      `;
      const row = rows[0];
      if (row?.turnId) {
        return { threadId: row.threadId, turnId: row.turnId };
      }
      yield* advanceRuntime;
    }
    assert.fail(`Timed out waiting for dispatch for ${ticketId}`);
  });

const seedAssistantOutput = (input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly text: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id,
        thread_id,
        turn_id,
        role,
        text,
        attachments_json,
        is_streaming,
        created_at,
        updated_at
      )
      VALUES (
        ${input.messageId},
        ${input.threadId},
        ${input.turnId},
        'assistant',
        ${input.text},
        NULL,
        0,
        '2026-06-07T00:00:00.000Z',
        '2026-06-07T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id,
        turn_id,
        pending_message_id,
        source_proposed_plan_thread_id,
        source_proposed_plan_id,
        assistant_message_id,
        state,
        requested_at,
        started_at,
        completed_at,
        checkpoint_turn_count,
        checkpoint_ref,
        checkpoint_status,
        checkpoint_files_json
      )
      VALUES (
        ${input.threadId},
        ${input.turnId},
        NULL,
        NULL,
        NULL,
        ${input.messageId},
        'completed',
        '2026-06-07T00:00:00.000Z',
        '2026-06-07T00:00:00.000Z',
        '2026-06-07T00:00:01.000Z',
        NULL,
        NULL,
        NULL,
        '[]'
      )
      ON CONFLICT (thread_id, turn_id)
      DO UPDATE SET
        assistant_message_id = excluded.assistant_message_id,
        state = excluded.state,
        completed_at = excluded.completed_at
    `;
  });

const registerSmartRoutingBoard = (input: {
  readonly boardId: string;
  readonly projectId: string;
}) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    const read = yield* WorkflowReadModel;
    const trust = yield* ProjectScriptTrust;

    yield* registry.register(input.boardId as never, smartRoutingDefinition);
    yield* read.registerBoard({
      boardId: input.boardId as never,
      projectId: input.projectId as never,
      name: "Smart routing runtime",
      workflowFilePath: ".t3/boards/smart-routing.json",
      workflowVersionHash: input.boardId,
      maxConcurrentTickets: 3,
    });
    yield* trust.setTrusted(input.projectId as never, true);
  });

const registerWipRuntimeBoard = (input: { readonly boardId: string; readonly projectId: string }) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    const read = yield* WorkflowReadModel;

    yield* registry.register(input.boardId as never, wipDrainDefinition);
    yield* read.registerBoard({
      boardId: input.boardId as never,
      projectId: input.projectId as never,
      name: "WIP runtime",
      workflowFilePath: ".t3/boards/wip-runtime.json",
      workflowVersionHash: input.boardId,
      maxConcurrentTickets: 3,
    });
  });

const assertBuildOccupancy = (
  read: WorkflowReadModel["Service"],
  boardId: string,
  expected: number,
) =>
  Effect.gen(function* () {
    const admitted = yield* read.countAdmittedInLane(boardId as never, "build" as never);
    assert.equal(admitted, expected);
    assert.isAtMost(admitted, 1);
  });

runtimeLayer("WorkflowRuntimeCoreLive", (it) => {
  it.effect("runs two real agent steps through the durable runtime", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const mock = yield* MockAcpProvider;

      yield* registry.register("board-runtime" as never, definition);
      const ticketId = yield* engine.createTicket({
        boardId: "board-runtime" as never,
        title: "Ship runtime",
        initialLane: "code" as never,
      });

      yield* waitFor(mock.startedCount.pipe(Effect.map((count) => count === 1)), "first turn");
      yield* mock.completeAllRunning();
      yield* waitForDetail(
        read,
        ticketId as string,
        (detail) => detail?.ticket.currentLaneKey === "review",
        "review lane",
      );

      yield* waitFor(mock.startedCount.pipe(Effect.map((count) => count === 2)), "second turn");
      yield* mock.completeAllRunning();
      const done = yield* waitForDetail(
        read,
        ticketId as string,
        (detail) => detail?.ticket.currentLaneKey === "done",
        "done lane",
      );

      assert.equal(done?.steps.filter((step) => step.status === "completed").length, 2);
    }),
  );

  it.effect("recovers an in-flight dispatch without starting a duplicate provider turn", () =>
    Effect.gen(function* () {
      const recovery = yield* WorkflowRecovery;
      const mock = yield* MockAcpProvider;
      const provider = yield* ProviderTurnPort;
      const sql = yield* SqlClient.SqlClient;
      const baselineStarts = yield* mock.startedCount;

      yield* provider.ensureTurnStarted({
        dispatchId: "dispatch-restart" as never,
        ticketId: "ticket-restart" as never,
        stepRunId: "step-run-restart" as never,
        threadId: "thread-restart" as never,
        providerInstance: "codex",
        model: "gpt-5.5",
        instruction: "recover the turn",
        worktreePath: "/tmp/wt-restart",
      });
      assert.equal(yield* mock.startedCount, baselineStarts + 1);

      yield* sql`
        INSERT INTO projection_board (
          board_id,
          project_id,
          name,
          workflow_file_path,
          workflow_version_hash,
          max_concurrent_tickets
        )
        VALUES (
          'board-restart',
          'project-restart',
          'Restart Board',
          '.t3/boards/restart.json',
          'hash-restart',
          3
        )
      `;
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'ticket-restart',
          'board-restart',
          'Recover restart',
          'impl',
          'running',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          created_at
        )
        VALUES (
          'dispatch-restart',
          'ticket-restart',
          'step-run-restart',
          'thread-restart',
          'codex',
          'gpt-5.5',
          'recover the turn',
          '/tmp/wt-restart',
          'pending',
          '2026-06-07T00:00:00.000Z'
        )
      `;

      const fiber = yield* Effect.forkChild(recovery.recover());
      yield* Effect.yieldNow;
      yield* mock.completeAllRunning();
      yield* advanceRuntime;
      yield* Fiber.join(fiber);

      yield* recovery.recover();

      assert.equal(yield* mock.startedCount, baselineStarts + 1);
      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM workflow_dispatch_outbox WHERE dispatch_id = 'dispatch-restart'
      `;
      assert.equal(rows[0]?.status, "confirmed");
    }),
  );

  it.effect("enforces WIP limit and drains queued auto-lane tickets FIFO", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const mock = yield* MockAcpProvider;
      const baselineStarts = yield* mock.startedCount;

      yield* registerWipRuntimeBoard({
        boardId: "board-wip-live",
        projectId: "project-wip-live",
      });
      const firstTicketId = yield* engine.createTicket({
        boardId: "board-wip-live" as never,
        title: "First WIP ticket",
        initialLane: "build" as never,
      });
      const secondTicketId = yield* engine.createTicket({
        boardId: "board-wip-live" as never,
        title: "Second WIP ticket",
        initialLane: "build" as never,
      });
      const thirdTicketId = yield* engine.createTicket({
        boardId: "board-wip-live" as never,
        title: "Third WIP ticket",
        initialLane: "build" as never,
      });

      yield* waitFor(
        mock.startedCount.pipe(Effect.map((count) => count === baselineStarts + 1)),
        "first WIP ticket start",
      );
      yield* assertBuildOccupancy(read, "board-wip-live", 1);
      const firstQueuedState = yield* waitForDetail(
        read,
        secondTicketId as string,
        (detail) => detail?.ticket.status === "queued" && detail.ticket.queuedAt !== null,
        "second ticket queued",
      );
      const thirdQueuedState = yield* waitForDetail(
        read,
        thirdTicketId as string,
        (detail) => detail?.ticket.status === "queued" && detail.ticket.queuedAt !== null,
        "third ticket queued",
      );
      assert.equal(firstQueuedState?.ticket.currentLaneEntryToken, null);
      assert.equal(thirdQueuedState?.ticket.currentLaneEntryToken, null);

      yield* mock.completeAllRunning();
      yield* waitForDetail(
        read,
        firstTicketId as string,
        (detail) => detail?.ticket.currentLaneKey === "done",
        "first ticket drained",
      );
      const secondAdmitted = yield* waitForDetail(
        read,
        secondTicketId as string,
        (detail) =>
          detail?.ticket.currentLaneKey === "build" &&
          detail.ticket.currentLaneEntryToken !== null &&
          detail.ticket.queuedAt === null,
        "second ticket FIFO admit",
      );
      const thirdStillQueued = yield* waitForDetail(
        read,
        thirdTicketId as string,
        (detail) => detail?.ticket.status === "queued" && detail.ticket.queuedAt !== null,
        "third ticket still queued after first drain",
      );
      assert.isNotNull(secondAdmitted?.ticket.currentLaneEntryToken);
      assert.equal(thirdStillQueued?.ticket.currentLaneEntryToken, null);
      yield* waitFor(
        mock.startedCount.pipe(Effect.map((count) => count === baselineStarts + 2)),
        "second WIP ticket start",
      );
      yield* assertBuildOccupancy(read, "board-wip-live", 1);

      yield* mock.completeAllRunning();
      yield* waitForDetail(
        read,
        secondTicketId as string,
        (detail) => detail?.ticket.currentLaneKey === "done",
        "second ticket drained",
      );
      const thirdAdmitted = yield* waitForDetail(
        read,
        thirdTicketId as string,
        (detail) =>
          detail?.ticket.currentLaneKey === "build" &&
          detail.ticket.currentLaneEntryToken !== null &&
          detail.ticket.queuedAt === null,
        "third ticket FIFO admit",
      );
      assert.isNotNull(thirdAdmitted?.ticket.currentLaneEntryToken);
      yield* waitFor(
        mock.startedCount.pipe(Effect.map((count) => count === baselineStarts + 3)),
        "third WIP ticket start",
      );
      yield* assertBuildOccupancy(read, "board-wip-live", 1);

      yield* mock.completeAllRunning();
      yield* waitForDetail(
        read,
        thirdTicketId as string,
        (detail) => detail?.ticket.currentLaneKey === "done",
        "third ticket drained",
      );
      yield* assertBuildOccupancy(read, "board-wip-live", 0);
    }),
  );

  it.effect("recovers stranded WIP admission and drains queued tickets FIFO", () =>
    Effect.gen(function* () {
      const recovery = yield* WorkflowRecovery;
      const read = yield* WorkflowReadModel;
      const committer = yield* WorkflowEventCommitter;
      const mock = yield* MockAcpProvider;
      const baselineStarts = yield* mock.startedCount;

      yield* registerWipRuntimeBoard({
        boardId: "board-wip-recovered-runtime",
        projectId: "project-wip-recovered-runtime",
      });
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-wip-recovered-first-created" as never,
        ticketId: "ticket-wip-recovered-first" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "board-wip-recovered-runtime" as never,
          title: "Recovered first WIP ticket",
          laneKey: "build" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-wip-recovered-first-admitted" as never,
        ticketId: "ticket-wip-recovered-first" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "build" as never,
          laneEntryToken: "tok-wip-recovered-first" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-wip-recovered-second-created" as never,
        ticketId: "ticket-wip-recovered-second" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          boardId: "board-wip-recovered-runtime" as never,
          title: "Recovered second WIP ticket",
          laneKey: "build" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketQueued",
        eventId: "evt-wip-recovered-second-queued" as never,
        ticketId: "ticket-wip-recovered-second" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: { lane: "build" as never },
      } as never);
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-wip-recovered-third-created" as never,
        ticketId: "ticket-wip-recovered-third" as never,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: {
          boardId: "board-wip-recovered-runtime" as never,
          title: "Recovered third WIP ticket",
          laneKey: "build" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketQueued",
        eventId: "evt-wip-recovered-third-queued" as never,
        ticketId: "ticket-wip-recovered-third" as never,
        occurredAt: "2026-06-07T00:00:05.000Z" as never,
        payload: { lane: "build" as never },
      } as never);

      yield* recovery.recover();
      yield* waitFor(
        mock.startedCount.pipe(Effect.map((count) => count === baselineStarts + 1)),
        "stranded recovered WIP ticket start",
      );
      yield* assertBuildOccupancy(read, "board-wip-recovered-runtime", 1);

      yield* recovery.recover();
      assert.equal(yield* mock.startedCount, baselineStarts + 1);

      yield* mock.completeAllRunning();
      yield* waitForDetail(
        read,
        "ticket-wip-recovered-first",
        (detail) => detail?.ticket.currentLaneKey === "done",
        "recovered first ticket drained",
      );
      yield* waitForDetail(
        read,
        "ticket-wip-recovered-second",
        (detail) =>
          detail?.ticket.currentLaneKey === "build" &&
          detail.ticket.currentLaneEntryToken !== null &&
          detail.ticket.queuedAt === null,
        "recovered second ticket FIFO admit",
      );
      yield* waitForDetail(
        read,
        "ticket-wip-recovered-third",
        (detail) => detail?.ticket.status === "queued" && detail.ticket.queuedAt !== null,
        "recovered third ticket still queued",
      );
      yield* waitFor(
        mock.startedCount.pipe(Effect.map((count) => count === baselineStarts + 2)),
        "recovered second ticket start",
      );
      yield* assertBuildOccupancy(read, "board-wip-recovered-runtime", 1);

      yield* mock.completeAllRunning();
      yield* waitForDetail(
        read,
        "ticket-wip-recovered-second",
        (detail) => detail?.ticket.currentLaneKey === "done",
        "recovered second ticket drained",
      );
      yield* waitForDetail(
        read,
        "ticket-wip-recovered-third",
        (detail) =>
          detail?.ticket.currentLaneKey === "build" &&
          detail.ticket.currentLaneEntryToken !== null &&
          detail.ticket.queuedAt === null,
        "recovered third ticket FIFO admit",
      );
      yield* waitFor(
        mock.startedCount.pipe(Effect.map((count) => count === baselineStarts + 3)),
        "recovered third ticket start",
      );
      yield* assertBuildOccupancy(read, "board-wip-recovered-runtime", 1);

      yield* mock.completeAllRunning();
      yield* waitForDetail(
        read,
        "ticket-wip-recovered-third",
        (detail) => detail?.ticket.currentLaneKey === "done",
        "recovered third ticket drained",
      );
      yield* assertBuildOccupancy(read, "board-wip-recovered-runtime", 0);
    }),
  );
});

smartRoutingLayer("WorkflowRuntime smart routing integration", (it) => {
  it.effect("branches live on script exit code and captured agent verdict", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const mock = yield* MockAcpProvider;
      const store = yield* WorkflowEventStore;
      const baselineStarts = yield* mock.startedCount;

      yield* registerSmartRoutingBoard({
        boardId: "board-smart-live",
        projectId: "project-smart-live",
      });
      const ticketId = yield* engine.createTicket({
        boardId: "board-smart-live" as never,
        title: "Smart live route",
        initialLane: "impl" as never,
      });

      const afterScript = yield* waitForDetail(
        read,
        ticketId as string,
        (detail) =>
          detail?.steps.some((step) => step.stepKey === "tests" && step.status !== "running") ===
          true,
        "script terminal step",
      );
      assert.equal(
        afterScript?.steps.find((step) => step.stepKey === "tests")?.status,
        "completed",
      );
      yield* waitFor(
        mock.startedCount.pipe(Effect.map((count) => count >= baselineStarts + 1)),
        "review turn",
      );
      const dispatch = yield* waitForDispatchForTicket(ticketId as string);
      yield* seedAssistantOutput({
        ...dispatch,
        messageId: "assistant-smart-live",
        text: 'Review complete.\n```json\n{"verdict":"block"}\n```',
      });
      yield* mock.completeAllRunning();

      const detail = yield* waitForDetail(
        read,
        ticketId as string,
        (detail) => detail?.ticket.currentLaneKey === "needs",
        "needs lane",
      );
      assert.equal(detail?.steps.find((step) => step.stepKey === "tests")?.exitCode, 1);
      assert.deepEqual(detail?.steps.find((step) => step.stepKey === "review")?.output, {
        verdict: "block",
      });

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const audit = events.find((event) => event.type === "TicketRouteDecided");
      assert.equal(audit?.type, "TicketRouteDecided");
      if (audit?.type !== "TicketRouteDecided") {
        assert.fail("expected TicketRouteDecided");
      }
      assert.equal(audit.payload.source, "lane_transition");
      assert.equal(audit.payload.toLane, "needs");
    }),
  );

  it.effect("branches recovered on script exit code and recovered agent output", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const committer = yield* WorkflowEventCommitter;
      const store = yield* WorkflowEventStore;
      const provider = yield* ProviderTurnPort;
      const mock = yield* MockAcpProvider;
      const recovery = yield* WorkflowRecovery;
      const sql = yield* SqlClient.SqlClient;

      yield* registerSmartRoutingBoard({
        boardId: "board-smart-recovered",
        projectId: "project-smart-recovered",
      });
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-smart-recovered-ticket" as never,
        ticketId: "ticket-smart-recovered" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "board-smart-recovered" as never,
          title: "Smart recovered route",
          laneKey: "impl" as never,
        },
      } as never);
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-smart-recovered-move" as never,
        ticketId: "ticket-smart-recovered" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: "impl" as never,
          laneEntryToken: "tok-smart-recovered" as never,
          reason: "initial",
        },
      } as never);
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-smart-recovered-pipeline" as never,
        ticketId: "ticket-smart-recovered" as never,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-smart-recovered" as never,
          laneKey: "impl" as never,
          laneEntryToken: "tok-smart-recovered" as never,
        },
      } as never);
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-smart-recovered-tests" as never,
        ticketId: "ticket-smart-recovered" as never,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-smart-recovered" as never,
          stepRunId: "step-smart-tests" as never,
          stepKey: "tests" as never,
          stepType: "script",
        },
      } as never);
      yield* committer.commit({
        type: "ScriptStepStarted",
        eventId: "evt-smart-recovered-script-started" as never,
        ticketId: "ticket-smart-recovered" as never,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: {
          scriptRunId: "script-smart-recovered" as never,
          stepRunId: "step-smart-tests" as never,
          scriptThreadId: "workflow-script:script-smart-recovered" as never,
          terminalId: "script-smart-recovered",
        },
      } as never);
      yield* committer.commit({
        type: "ScriptStepExited",
        eventId: "evt-smart-recovered-script-exited" as never,
        ticketId: "ticket-smart-recovered" as never,
        occurredAt: "2026-06-07T00:00:05.000Z" as never,
        payload: {
          scriptRunId: "script-smart-recovered" as never,
          exitCode: 1,
          signal: null,
          outcome: "exited",
        },
      } as never);
      yield* committer.commit({
        type: "StepCompleted",
        eventId: "evt-smart-recovered-tests-completed" as never,
        ticketId: "ticket-smart-recovered" as never,
        occurredAt: "2026-06-07T00:00:06.000Z" as never,
        payload: { stepRunId: "step-smart-tests" as never },
      } as never);
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-smart-recovered-review" as never,
        ticketId: "ticket-smart-recovered" as never,
        occurredAt: "2026-06-07T00:00:07.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-smart-recovered" as never,
          stepRunId: "step-smart-review" as never,
          stepKey: "review" as never,
          stepType: "agent",
        },
      } as never);

      const { turnId } = yield* provider.ensureTurnStarted({
        dispatchId: "dispatch-smart-recovered" as never,
        ticketId: "ticket-smart-recovered" as never,
        stepRunId: "step-smart-review" as never,
        threadId: "thread-smart-recovered" as never,
        providerInstance: "codex",
        model: "gpt-5.5",
        instruction: "Review the test result",
        worktreePath: "/tmp/wt-smart-recovered",
      });
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          turn_id,
          created_at,
          started_at
        )
        VALUES (
          'dispatch-smart-recovered',
          'ticket-smart-recovered',
          'step-smart-review',
          'thread-smart-recovered',
          'codex',
          'gpt-5.5',
          'Review the test result',
          '/tmp/wt-smart-recovered',
          'started',
          ${turnId},
          '2026-06-07T00:00:08.000Z',
          '2026-06-07T00:00:08.000Z'
        )
      `;
      yield* seedAssistantOutput({
        threadId: "thread-smart-recovered",
        turnId: turnId as string,
        messageId: "assistant-smart-recovered",
        text: 'Recovered review.\n```json\n{"verdict":"block"}\n```',
      });
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          turn_id,
          created_at,
          started_at,
          confirmed_at
        )
        VALUES (
          'dispatch-smart-recovered-newer',
          'ticket-smart-recovered',
          'step-smart-review',
          'thread-smart-recovered',
          'codex',
          'gpt-5.5',
          'Newer unrelated dispatch',
          '/tmp/wt-smart-recovered',
          'confirmed',
          'turn-smart-recovered-newer',
          '2026-06-07T00:00:09.000Z',
          '2026-06-07T00:00:09.000Z',
          '2026-06-07T00:00:10.000Z'
        )
      `;
      yield* seedAssistantOutput({
        threadId: "thread-smart-recovered",
        turnId: "turn-smart-recovered-newer",
        messageId: "assistant-smart-recovered-newer",
        text: 'Newer unrelated review.\n```json\n{"verdict":"pass"}\n```',
      });
      yield* mock.completeAllRunning();
      yield* recovery.recover();

      const detail = yield* waitForDetail(
        read,
        "ticket-smart-recovered",
        (detail) => detail?.ticket.currentLaneKey === "needs",
        "recovered needs lane",
      );
      assert.equal(detail?.steps.find((step) => step.stepKey === "tests")?.exitCode, 1);
      assert.deepEqual(detail?.steps.find((step) => step.stepKey === "review")?.output, {
        verdict: "block",
      });

      const events = yield* Stream.runCollect(
        store.readByTicket("ticket-smart-recovered" as never),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const audit = events.find((event) => event.type === "TicketRouteDecided");
      assert.equal(audit?.type, "TicketRouteDecided");
      if (audit?.type !== "TicketRouteDecided") {
        assert.fail("expected TicketRouteDecided");
      }
      assert.equal(audit.payload.source, "lane_transition");
      assert.equal(audit.payload.toLane, "needs");
    }),
  );
});
