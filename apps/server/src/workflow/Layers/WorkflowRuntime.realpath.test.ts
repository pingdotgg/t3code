// @effect-diagnostics globalTimers:off
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vitest";
import { BoardId, LaneKey, ProjectId, TicketId, TurnId, type VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { ServerConfig } from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { ProviderTurnPort, type DispatchRequest } from "../Services/ProviderDispatchOutbox.ts";
import {
  ProviderResponsePort,
  type ProviderResponseInput,
} from "../Services/ProviderResponsePort.ts";
import { SetupTerminalPort } from "../Services/SetupRunService.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { TicketDiffQuery } from "../Services/TicketDiffQuery.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowRecovery } from "../Services/WorkflowRecovery.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { TicketCheckpointServiceLive } from "./TicketCheckpointService.ts";
import { TicketDiffQueryLive, WorktreeDiffPortLive } from "./TicketDiffQuery.ts";
import { WorktreePortLive } from "./RealStepExecutor.ts";
import { TurnProjectionPortLive } from "./TurnStateReader.ts";
import { WorkflowRuntimeCoreLive } from "../WorkflowRuntimeLive.ts";
import { MergeGitPortLive } from "./TicketMergeService.ts";
import { TicketPullRequestService } from "../Services/TicketPullRequestService.ts";
import { ticketBaseRef } from "../ticketRefs.ts";
import { WorktreePort } from "../Services/WorktreePort.ts";

interface ProviderCall {
  readonly threadId: string;
  readonly instruction: string;
  readonly turnId: string;
  readonly worktreePath: string;
}

interface RealPathProviderDoubleShape {
  readonly calls: Effect.Effect<ReadonlyArray<ProviderCall>>;
  readonly completeThread: (threadId: string) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly reset: Effect.Effect<void>;
  readonly responses: Effect.Effect<ReadonlyArray<ProviderResponseInput>>;
}

class RealPathProviderDouble extends Context.Service<
  RealPathProviderDouble,
  RealPathProviderDoubleShape
>()("t3/workflow/Layers/WorkflowRuntime.realpath.test/RealPathProviderDouble") {}

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-workflow-realpath-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const PullRequestStubLive = Layer.mergeAll(
  Layer.succeed(TicketPullRequestService, {
    open: () => Effect.succeed({ _tag: "completed" }),
    land: () => Effect.succeed({ _tag: "completed" }),
  }),
  Layer.succeed(GitHubCli, {} as never),
  Layer.succeed(SourceControlProviderRegistry, {} as never),
);
const GitVcsDriverTestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);
const GitWorkflowServiceTestLayer = GitWorkflowService.layer.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(GitVcsDriverTestLayer),
  Layer.provide(Layer.mock(GitManager.GitManager)({})),
);

const toProviderDoubleError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const RealPathProviderDoubleLive = Layer.unwrap(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const calls = yield* Ref.make<ReadonlyArray<ProviderCall>>([]);
    const responses = yield* Ref.make<ReadonlyArray<ProviderResponseInput>>([]);
    const heldAfterAnswerThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
    const turnCounters = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    const appendInstruction = (request: DispatchRequest) =>
      Effect.gen(function* () {
        const outputPath = NodePath.join(request.worktreePath, "workflow-output.txt");
        const existing = yield* fileSystem
          .exists(outputPath)
          .pipe(
            Effect.flatMap((exists) =>
              exists ? fileSystem.readFileString(outputPath) : Effect.succeed(""),
            ),
          );
        yield* fileSystem.writeFileString(outputPath, `${existing}${request.instruction}\n`);
      });

    const upsertTurnState = (input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly state: "running" | "completed" | "interrupted";
    }) =>
      sql`
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
          NULL,
          ${input.state},
          '2026-06-07T00:01:00.000Z',
          '2026-06-07T00:01:00.000Z',
          ${input.state === "running" ? null : "2026-06-07T00:01:01.000Z"},
          NULL,
          NULL,
          NULL,
          '[]'
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          state = excluded.state,
          completed_at = excluded.completed_at
      `.pipe(Effect.mapError(toProviderDoubleError("provider double turn state failed")));

    const nextTurnId = (threadId: string) =>
      Ref.modify(turnCounters, (current) => {
        const nextValue = (current.get(threadId) ?? 0) + 1;
        const next = new Map(current);
        next.set(threadId, nextValue);
        return [`turn-${threadId}-${nextValue}`, next] as const;
      });

    const activeProjectedTurn = (threadId: string) =>
      sql<{ readonly turnId: string; readonly state: string }>`
        SELECT turn_id AS "turnId", state
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NOT NULL
        ORDER BY requested_at ASC, turn_id ASC
      `.pipe(
        Effect.map(
          (rows) =>
            rows.findLast((row) => row.state === "pending" || row.state === "running") ?? null,
        ),
        Effect.mapError(toProviderDoubleError("provider double active turn lookup failed")),
      );

    const insertUserInputRequest = (threadId: string, turnId: string) =>
      sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          ${`activity-user-input-requested-${threadId}`},
          ${threadId},
          ${turnId},
          'approval',
          'user-input.requested',
          'Question for workflow',
          ${JSON.stringify({
            requestId: `request-${threadId}`,
            questions: [
              {
                id: `question-${threadId}`,
                question: "Question for workflow",
              },
            ],
          })},
          1,
          '2026-06-07T00:00:00.000Z'
        )
      `.pipe(Effect.mapError(toProviderDoubleError("provider double user input failed")));

    const insertUserInputResolved = (input: ProviderResponseInput) =>
      sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          ${`activity-user-input-resolved-${input.threadId}`},
          ${input.threadId},
          NULL,
          'approval',
          'user-input.resolved',
          'Question answered',
          ${JSON.stringify({ requestId: input.requestId, approved: input.approved })},
          2,
          '2026-06-07T00:00:01.000Z'
        )
      `.pipe(Effect.mapError(toProviderDoubleError("provider double user input failed")));

    const completeThread = (threadId: string) =>
      Effect.gen(function* () {
        const active = yield* activeProjectedTurn(threadId);
        if (active === null) {
          return;
        }
        yield* upsertTurnState({ threadId, turnId: active.turnId, state: "completed" });
      });

    const providerTurnPort = ProviderTurnPort.of({
      ensureTurnStarted: (request) =>
        Effect.gen(function* () {
          const threadKey = request.threadId as string;
          const activeTurn = yield* activeProjectedTurn(threadKey);
          if (activeTurn !== null) {
            return { turnId: TurnId.make(activeTurn.turnId) };
          }

          const turnIdString = yield* nextTurnId(threadKey);
          const turnId = TurnId.make(turnIdString);
          yield* Ref.update(calls, (current) => [
            ...current,
            {
              threadId: threadKey,
              instruction: request.instruction,
              turnId: turnIdString,
              worktreePath: request.worktreePath,
            },
          ]);
          yield* upsertTurnState({ threadId: threadKey, turnId: turnIdString, state: "running" });
          yield* appendInstruction(request);
          if (request.instruction.includes("ASK_PROVIDER_QUESTION")) {
            yield* insertUserInputRequest(threadKey, turnIdString);
            if (request.instruction.includes("DELAY_AFTER_ANSWER")) {
              yield* Ref.update(heldAfterAnswerThreads, (current) => {
                const next = new Set(current);
                next.add(threadKey);
                return next;
              });
            }
            return { turnId };
          }
          yield* upsertTurnState({ threadId: threadKey, turnId: turnIdString, state: "completed" });
          return { turnId };
        }).pipe(Effect.mapError(toProviderDoubleError("provider double turn failed"))),
    });

    const providerResponsePort = ProviderResponsePort.of({
      respond: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(responses, (current) => [...current, input]);
          yield* insertUserInputResolved(input);
          const threadId = input.threadId as string;
          const heldThreads = yield* Ref.get(heldAfterAnswerThreads);
          if (!heldThreads.has(threadId)) {
            yield* completeThread(threadId);
          }
        }).pipe(Effect.mapError(toProviderDoubleError("provider double response failed"))),
    });

    const tracker = RealPathProviderDouble.of({
      calls: Ref.get(calls),
      completeThread,
      reset: Effect.all(
        [
          Ref.set(calls, []),
          Ref.set(responses, []),
          Ref.set(heldAfterAnswerThreads, new Set()),
          Ref.set(turnCounters, new Map()),
        ],
        { discard: true },
      ),
      responses: Ref.get(responses),
    });

    return Layer.mergeAll(
      Layer.succeed(ProviderTurnPort, providerTurnPort),
      Layer.succeed(ProviderResponsePort, providerResponsePort),
      Layer.succeed(RealPathProviderDouble, tracker),
    );
  }),
);

const TestLayer = Layer.mergeAll(WorkflowRuntimeCoreLive, TicketDiffQueryLive).pipe(
  Layer.provideMerge(RealPathProviderDoubleLive),
  Layer.provideMerge(
    Layer.succeed(TerminalManager, {
      open: () => Effect.die("unused terminal.open"),
      attachStream: () => Effect.die("unused terminal.attachStream"),
      attachHistoryStream: () => Effect.die("unused terminal.attachHistoryStream"),
      write: () => Effect.die("unused terminal.write"),
      resize: () => Effect.die("unused terminal.resize"),
      clear: () => Effect.die("unused terminal.clear"),
      restart: () => Effect.die("unused terminal.restart"),
      close: () => Effect.void,
      getSnapshot: () => Effect.succeed(null),
      subscribe: () => Effect.succeed(() => undefined),
      subscribeMetadata: () => Effect.succeed(() => undefined),
    }),
  ),
  Layer.provideMerge(TurnProjectionPortLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(WorktreePortLive),
  Layer.provideMerge(TicketCheckpointServiceLive),
  Layer.provideMerge(CheckpointStore.layer),
  Layer.provideMerge(WorktreeDiffPortLive),
  Layer.provideMerge(
    Layer.succeed(SetupTerminalPort, {
      launch: () => Effect.succeed({ threadId: "workflow-setup:stub", terminalId: null }),
      awaitExit: () => Effect.succeed({ exitCode: 0 }),
    }),
  ),
  Layer.provideMerge(DeterministicWorkflowIds),
  // The real GitHubPortLive is wired into the executor; these tests never run
  // PR steps, so stub the PR service and its source-control deps to keep the
  // layer self-contained.
  Layer.provideMerge(PullRequestStubLive),
  Layer.provideMerge(GitWorkflowServiceTestLayer),
  Layer.provideMerge(MergeGitPortLive),
  Layer.provideMerge(GitVcsDriverTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "workflow-realpath-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });

const makeDirectory = (
  directoryPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(directoryPath, { recursive: true });
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "WorkflowRuntime.realpath.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(NodePath.join(cwd, "README.md"), "# workflow repo\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });

const withProcessCwd = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const previous = process.cwd();
    yield* Effect.sync(() => process.chdir(cwd));
    return yield* effect.pipe(Effect.ensuring(Effect.sync(() => process.chdir(previous))));
  });

const waitForDetail = (
  read: WorkflowReadModel["Service"],
  ticketId: TicketId,
  predicate: (detail: TicketDetail | null) => boolean,
  label: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const detail = yield* read.getTicketDetail(ticketId);
      if (predicate(detail)) {
        return detail;
      }
      yield* TestClock.adjust("50 millis");
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 25)));
      yield* Effect.yieldNow;
    }
    assert.fail(`Timed out waiting for ${label}`);
  });

const seedProject = (projectId: ProjectId, repoRoot: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id,
        title,
        workspace_root,
        default_model_selection_json,
        scripts_json,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${projectId},
        'Workflow project',
        ${repoRoot},
        NULL,
        '[]',
        '2026-06-07T00:00:00.000Z',
        '2026-06-07T00:00:00.000Z',
        NULL
      )
    `;
  });

const registerBoardProjection = (input: {
  readonly boardId: BoardId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly repoRoot: string;
}) =>
  Effect.gen(function* () {
    const read = yield* WorkflowReadModel;
    yield* read.registerBoard({
      boardId: input.boardId,
      projectId: input.projectId,
      name: input.name,
      workflowFilePath: NodePath.join(input.repoRoot, ".t3", "boards", "delivery.json"),
      workflowVersionHash: "test",
      maxConcurrentTickets: 1,
    });
  });

describe.sequential("Workflow runtime real path", () => {
  it.effect("runs a two-step agent pipeline in one project worktree with accumulated diff", () =>
    Effect.gen(function* () {
      const targetRepo = yield* makeTmpDir("workflow-target-repo-");
      const wrongRepo = yield* makeTmpDir("workflow-wrong-cwd-");
      yield* initRepoWithCommit(targetRepo);
      yield* initRepoWithCommit(wrongRepo);
      yield* makeDirectory(NodePath.join(targetRepo, "prompts"));
      yield* writeTextFile(NodePath.join(targetRepo, "prompts", "step-one.md"), "first file prompt");

      const boardId = BoardId.make("board-realpath");
      const projectId = ProjectId.make("project-realpath");
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const provider = yield* RealPathProviderDouble;

      yield* provider.reset;
      yield* seedProject(projectId, targetRepo);
      yield* registry.register(boardId, {
        name: "Real path board",
        lanes: [
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            pipeline: [
              {
                key: "code",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: { file: "prompts/step-one.md" },
              },
              {
                key: "review",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "second inline prompt",
              },
            ],
            on: { success: "done", failure: "needs_attention" },
          },
          { key: "needs_attention", name: "Needs attention", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      yield* registerBoardProjection({
        boardId,
        projectId,
        name: "Real path board",
        repoRoot: targetRepo,
      });

      const { ticketId, done } = yield* withProcessCwd(
        wrongRepo,
        Effect.gen(function* () {
          const ticketId = yield* engine.createTicket({
            boardId,
            title: "Ship a real worktree ticket",
            initialLane: LaneKey.make("implement"),
          });
          const done = yield* waitForDetail(
            read,
            ticketId,
            (detail) =>
              detail?.ticket.currentLaneKey === "done" ||
              detail?.ticket.currentLaneKey === "needs_attention",
            "terminal lane",
          );
          return { ticketId, done };
        }),
      );
      const calls = yield* provider.calls;

      assert.equal(done?.ticket.currentLaneKey, "done");
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.worktreePath, calls[1]?.worktreePath);
      assert.isTrue((calls[0]?.worktreePath ?? "").includes(NodePath.basename(targetRepo)));
      assert.equal(calls[0]?.instruction, "first file prompt");
      assert.equal(calls[1]?.instruction, "second inline prompt");
      assert.match(
        yield* git(targetRepo, ["branch", "--list", "workflow/ticket-1"]),
        /workflow\/ticket-1/,
      );
      assert.equal(yield* git(wrongRepo, ["branch", "--list", "workflow/ticket-1"]), "");

      const ticketDiff = yield* TicketDiffQuery;
      const diff = yield* ticketDiff.getTicketDiff(
        ticketId,
        calls[0]?.worktreePath ?? "",
        ticketBaseRef(ticketId),
      );
      assert.include(diff.patch, "+first file prompt");
      assert.include(diff.patch, "+second inline prompt");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("surfaces a real provider question as waiting_on_user and resumes the pipeline", () =>
    Effect.gen(function* () {
      const repo = yield* makeTmpDir("workflow-question-repo-");
      yield* initRepoWithCommit(repo);

      const boardId = BoardId.make("board-question");
      const projectId = ProjectId.make("project-question");
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const provider = yield* RealPathProviderDouble;

      yield* provider.reset;
      yield* seedProject(projectId, repo);
      yield* registry.register(boardId, {
        name: "Question board",
        lanes: [
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            pipeline: [
              {
                key: "ask",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "ASK_PROVIDER_QUESTION",
              },
              {
                key: "continue",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "continue after answer",
              },
            ],
            on: { success: "done", failure: "needs_attention" },
          },
          { key: "needs_attention", name: "Needs attention", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      yield* registerBoardProjection({
        boardId,
        projectId,
        name: "Question board",
        repoRoot: repo,
      });

      const ticketId = yield* withProcessCwd(
        repo,
        engine.createTicket({
          boardId,
          title: "Question ticket",
          initialLane: LaneKey.make("implement"),
        }),
      );
      const waiting = yield* waitForDetail(
        read,
        ticketId,
        (detail) => detail?.ticket.status === "waiting_on_user",
        "provider question",
      );
      if (waiting === null) {
        assert.fail("Expected provider question detail");
      }
      const awaitingStep = waiting.steps.find((step) => step.status === "awaiting_user");
      assert.isDefined(awaitingStep);

      yield* engine.answerTicketStep({
        stepRunId: awaitingStep?.stepRunId as never,
        text: "Continue after answer.",
      });
      const done = yield* waitForDetail(
        read,
        ticketId,
        (detail) => detail?.ticket.currentLaneKey === "done",
        "question pipeline completion",
      );
      if (done === null) {
        assert.fail("Expected completed question detail");
      }
      const calls = yield* provider.calls;
      const responses = yield* provider.responses;

      assert.equal(done.ticket.currentLaneKey, "done");
      assert.equal(calls.length, 2);
      assert.deepEqual(
        responses.map((response) => response.responseKind),
        ["user-input"],
      );
      assert.deepEqual(
        responses.map((response) => response.text),
        ["Continue after answer."],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("restarts a dead autonomous agent turn and continues the recovered pipeline", () =>
    Effect.gen(function* () {
      const repo = yield* makeTmpDir("workflow-autonomous-restart-repo-");
      yield* initRepoWithCommit(repo);

      const boardId = BoardId.make("board-autonomous-restart");
      const projectId = ProjectId.make("project-autonomous-restart");
      const ticketId = TicketId.make("ticket-autonomous-restart");
      const pipelineRunId = "pipeline-autonomous-restart" as never;
      const stepRunId = "step-autonomous-restart" as never;
      const threadId = "thread-autonomous-restart" as never;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const recovery = yield* WorkflowRecovery;
      const committer = yield* WorkflowEventCommitter;
      const provider = yield* RealPathProviderDouble;
      const worktrees = yield* WorktreePort;
      const sql = yield* SqlClient.SqlClient;

      yield* provider.reset;
      yield* seedProject(projectId, repo);
      yield* registry.register(boardId, {
        name: "Autonomous restart board",
        lanes: [
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            pipeline: [
              {
                key: "first",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "recover interrupted autonomous step",
              },
              {
                key: "second",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "continue after recovered step",
              },
            ],
            on: { success: "done", failure: "needs_attention" },
          },
          { key: "needs_attention", name: "Needs attention", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      yield* registerBoardProjection({
        boardId,
        projectId,
        name: "Autonomous restart board",
        repoRoot: repo,
      });
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-autonomous-ticket-created" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId,
          title: "Autonomous restart ticket",
          laneKey: LaneKey.make("implement"),
        },
      });
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-autonomous-ticket-moved" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: LaneKey.make("implement"),
          laneEntryToken: "token-autonomous-restart" as never,
          reason: "initial",
        },
      });
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-autonomous-pipeline-started" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId,
          laneKey: LaneKey.make("implement"),
          laneEntryToken: "token-autonomous-restart" as never,
        },
      });
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-autonomous-step-started" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId,
          stepRunId,
          stepKey: "first" as never,
          stepType: "agent",
        },
      });

      const worktree = yield* worktrees.ensureWorktree(ticketId);
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
          ${threadId},
          'turn-autonomous-dead',
          NULL,
          NULL,
          NULL,
          NULL,
          'running',
          '2026-06-07T00:00:03.000Z',
          '2026-06-07T00:00:03.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          turn_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          created_at,
          started_at
        )
        VALUES (
          'dispatch-autonomous-restart',
          ${ticketId},
          ${stepRunId},
          ${threadId},
          'turn-autonomous-dead',
          'codex',
          'gpt-5.5',
          'recover interrupted autonomous step',
          ${worktree.path},
          'started',
          '2026-06-07T00:00:03.000Z',
          '2026-06-07T00:00:03.000Z'
        )
      `;

      yield* recovery.recover();
      const done = yield* waitForDetail(
        read,
        ticketId,
        (detail) => detail?.ticket.currentLaneKey === "done",
        "autonomous restart completion",
      );
      if (done === null) {
        assert.fail("Expected completed autonomous restart detail");
      }
      const calls = yield* provider.calls;

      assert.equal(done.ticket.currentLaneKey, "done");
      assert.deepEqual(
        calls.map((call) => call.instruction),
        ["recover interrupted autonomous step", "continue after recovered step"],
      );
      assert.isAbove(new Set(calls.map((call) => call.turnId)).size, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "does not start the next provider-question step before the answered turn completes",
    () =>
      Effect.gen(function* () {
        const repo = yield* makeTmpDir("workflow-question-race-repo-");
        yield* initRepoWithCommit(repo);

        const boardId = BoardId.make("board-question-race");
        const projectId = ProjectId.make("project-question-race");
        const registry = yield* BoardRegistry;
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;
        const provider = yield* RealPathProviderDouble;

        yield* provider.reset;
        yield* seedProject(projectId, repo);
        yield* registry.register(boardId, {
          name: "Question race board",
          lanes: [
            {
              key: "implement",
              name: "Implement",
              entry: "auto",
              pipeline: [
                {
                  key: "ask",
                  type: "agent",
                  agent: { instance: "codex", model: "gpt-5.5" },
                  instruction: "ASK_PROVIDER_QUESTION DELAY_AFTER_ANSWER",
                },
                {
                  key: "after-answer",
                  type: "agent",
                  agent: { instance: "codex", model: "gpt-5.5" },
                  instruction: "must wait for answered turn terminal",
                },
              ],
              on: { success: "done", failure: "needs_attention" },
            },
            { key: "needs_attention", name: "Needs attention", entry: "manual" },
            { key: "done", name: "Done", entry: "manual", terminal: true },
          ],
        });
        yield* registerBoardProjection({
          boardId,
          projectId,
          name: "Question race board",
          repoRoot: repo,
        });

        const ticketId = yield* engine.createTicket({
          boardId,
          title: "Question race ticket",
          initialLane: LaneKey.make("implement"),
        });
        const waiting = yield* waitForDetail(
          read,
          ticketId,
          (detail) => detail?.ticket.status === "waiting_on_user",
          "delayed provider question",
        );
        const awaitingStep = waiting?.steps.find((step) => step.status === "awaiting_user");
        assert.isDefined(awaitingStep);

        const firstCalls = yield* provider.calls;
        const questionThreadId = firstCalls[0]?.threadId;
        assert.isDefined(questionThreadId);

        const resolveFiber = yield* Effect.forkChild(
          engine.answerTicketStep({
            stepRunId: awaitingStep?.stepRunId as never,
            text: "Continue after delayed answer.",
          }),
        );
        yield* waitForDetail(
          read,
          ticketId,
          (detail) => detail?.ticket.status !== "waiting_on_user",
          "question answer projection",
        );
        yield* TestClock.adjust("250 millis");
        yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 25)));
        const callsBeforeTerminal = yield* provider.calls;
        assert.deepEqual(
          callsBeforeTerminal.map((call) => call.instruction),
          ["ASK_PROVIDER_QUESTION DELAY_AFTER_ANSWER"],
        );

        yield* provider.completeThread(questionThreadId);
        yield* Fiber.join(resolveFiber);
        const done = yield* waitForDetail(
          read,
          ticketId,
          (detail) => detail?.ticket.currentLaneKey === "done",
          "question race completion",
        );
        assert.equal(done?.ticket.currentLaneKey, "done");
        const callsAfterTerminal = yield* provider.calls;
        assert.equal(callsAfterTerminal.length, 2);
        assert.equal(
          callsAfterTerminal[0]?.instruction,
          "ASK_PROVIDER_QUESTION DELAY_AFTER_ANSWER",
        );
        // The question/answer dialogue becomes ticket messages, so the next
        // step's instruction carries the appended discussion transcript.
        assert.match(
          callsAfterTerminal[1]?.instruction ?? "",
          /^must wait for answered turn terminal\n\n## Ticket discussion\n\n/,
        );
        assert.include(callsAfterTerminal[1]?.instruction ?? "", "Continue after delayed answer.");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "recovery returns promptly for a non-terminal dispatch whose provider session is gone",
    () =>
      Effect.gen(function* () {
        const repo = yield* makeTmpDir("workflow-recovery-repo-");
        yield* initRepoWithCommit(repo);
        const sql = yield* SqlClient.SqlClient;
        const recovery = yield* WorkflowRecovery;
        const provider = yield* RealPathProviderDouble;

        yield* provider.reset;
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
            'board-nonterminal',
            'project-nonterminal',
            'Nonterminal Board',
            '.t3/boards/nonterminal.json',
            'hash-nonterminal',
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
            'ticket-nonterminal',
            'board-nonterminal',
            'Recover nonterminal dispatch',
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
          created_at,
          started_at
        )
        VALUES (
          'dispatch-nonterminal',
          'ticket-nonterminal',
          'step-nonterminal',
          'thread-nonterminal',
          'codex',
          'gpt-5.5',
          'recover without hanging',
          ${repo},
          'started',
          '2026-06-07T00:00:00.000Z',
          '2026-06-07T00:00:00.000Z'
        )
      `;

        const fiber = yield* Effect.forkChild(recovery.recover());
        let completed = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const exit = yield* Effect.sync(() => fiber.pollUnsafe());
          if (exit !== undefined) {
            completed = true;
            break;
          }
          yield* TestClock.adjust("100 millis");
          yield* Effect.yieldNow;
        }
        if (!completed) {
          yield* Fiber.interrupt(fiber);
          assert.fail("Timed out waiting for workflow recovery to return");
        }
        yield* Fiber.join(fiber);
        const calls = yield* provider.calls;

        assert.deepEqual(
          calls.map((call) => call.threadId),
          ["thread-nonterminal"],
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resumes an approval step across restart and continues the pipeline", () =>
    Effect.gen(function* () {
      const repo = yield* makeTmpDir("workflow-approval-restart-repo-");
      yield* initRepoWithCommit(repo);

      const boardId = BoardId.make("board-approval-restart");
      const projectId = ProjectId.make("project-approval-restart");
      const ticketId = TicketId.make("ticket-approval-restart");
      const approvalStepRunId = "step-approval-restart" as never;
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const recovery = yield* WorkflowRecovery;
      const committer = yield* WorkflowEventCommitter;
      const provider = yield* RealPathProviderDouble;

      yield* provider.reset;
      yield* seedProject(projectId, repo);
      yield* registry.register(boardId, {
        name: "Approval restart board",
        lanes: [
          {
            key: "review",
            name: "Review",
            entry: "auto",
            pipeline: [
              {
                key: "approve",
                type: "approval",
                prompt: "Approve continuing?",
              },
              {
                key: "after-approval",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "continue after durable approval",
              },
            ],
            on: { success: "done", failure: "needs_attention" },
          },
          { key: "needs_attention", name: "Needs attention", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      yield* registerBoardProjection({
        boardId,
        projectId,
        name: "Approval restart board",
        repoRoot: repo,
      });
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-approval-ticket-created" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId,
          title: "Approval restart ticket",
          laneKey: LaneKey.make("review"),
        },
      });
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-approval-ticket-moved" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: LaneKey.make("review"),
          laneEntryToken: "token-approval-restart" as never,
          reason: "initial",
        },
      });
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-approval-pipeline-started" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-approval-restart" as never,
          laneKey: LaneKey.make("review"),
          laneEntryToken: "token-approval-restart" as never,
        },
      });
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-approval-step-started" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-approval-restart" as never,
          stepRunId: approvalStepRunId,
          stepKey: "approve" as never,
          stepType: "approval",
        },
      });
      yield* committer.commit({
        type: "StepAwaitingUser",
        eventId: "evt-approval-awaiting-user" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: {
          stepRunId: approvalStepRunId,
          waitingReason: "Approve continuing?",
        },
      });

      yield* recovery.recover();
      yield* engine.resolveApproval(approvalStepRunId, true);
      const done = yield* waitForDetail(
        read,
        ticketId,
        (detail) => detail?.ticket.currentLaneKey === "done",
        "approval restart completion",
      );
      if (done === null) {
        assert.fail("Expected completed approval restart detail");
      }
      const calls = yield* provider.calls;

      assert.equal(done.ticket.currentLaneKey, "done");
      assert.equal(calls.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resumes a provider question across restart and continues the pipeline", () =>
    Effect.gen(function* () {
      const repo = yield* makeTmpDir("workflow-provider-restart-repo-");
      yield* initRepoWithCommit(repo);

      const boardId = BoardId.make("board-provider-restart");
      const projectId = ProjectId.make("project-provider-restart");
      const ticketId = TicketId.make("ticket-provider-restart");
      const stepRunId = "step-provider-restart" as never;
      const threadId = "thread-provider-restart" as never;
      const requestId = "request-provider-restart" as never;
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const recovery = yield* WorkflowRecovery;
      const committer = yield* WorkflowEventCommitter;
      const provider = yield* RealPathProviderDouble;
      const sql = yield* SqlClient.SqlClient;

      yield* provider.reset;
      yield* seedProject(projectId, repo);
      yield* registry.register(boardId, {
        name: "Provider restart board",
        lanes: [
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            pipeline: [
              {
                key: "ask",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "ASK_PROVIDER_QUESTION",
              },
              {
                key: "continue",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "continue after durable provider question",
              },
            ],
            on: { success: "done", failure: "needs_attention" },
          },
          { key: "needs_attention", name: "Needs attention", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      yield* registerBoardProjection({
        boardId,
        projectId,
        name: "Provider restart board",
        repoRoot: repo,
      });
      yield* committer.commit({
        type: "TicketCreated",
        eventId: "evt-provider-ticket-created" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId,
          title: "Provider restart ticket",
          laneKey: LaneKey.make("implement"),
        },
      });
      yield* committer.commit({
        type: "TicketMovedToLane",
        eventId: "evt-provider-ticket-moved" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: {
          toLane: LaneKey.make("implement"),
          laneEntryToken: "token-provider-restart" as never,
          reason: "initial",
        },
      });
      yield* committer.commit({
        type: "PipelineStarted",
        eventId: "evt-provider-pipeline-started" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-provider-restart" as never,
          laneKey: LaneKey.make("implement"),
          laneEntryToken: "token-provider-restart" as never,
        },
      });
      yield* committer.commit({
        type: "StepStarted",
        eventId: "evt-provider-step-started" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:03.000Z" as never,
        payload: {
          pipelineRunId: "pipeline-provider-restart" as never,
          stepRunId,
          stepKey: "ask" as never,
          stepType: "agent",
        },
      });
      yield* committer.commit({
        type: "StepAwaitingUser",
        eventId: "evt-provider-awaiting-user" as never,
        ticketId,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: {
          stepRunId,
          waitingReason: "Provider is waiting for user input",
          providerThreadId: threadId,
          providerRequestId: requestId,
          providerResponseKind: "user-input",
        },
      });
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
          ${threadId},
          'turn-provider-restart',
          NULL,
          NULL,
          NULL,
          NULL,
          'running',
          '2026-06-07T00:00:04.000Z',
          '2026-06-07T00:00:04.000Z',
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
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
          created_at,
          started_at
        )
        VALUES (
          'dispatch-provider-restart',
          ${ticketId},
          ${stepRunId},
          ${threadId},
          'codex',
          'gpt-5.5',
          'ASK_PROVIDER_QUESTION',
          ${repo},
          'started',
          '2026-06-07T00:00:04.000Z',
          '2026-06-07T00:00:04.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-provider-restart-user-input',
          ${threadId},
          'turn-provider-restart',
          'approval',
          'user-input.requested',
          'Provider restart question',
          ${`{"requestId":"${requestId}"}`},
          1,
          '2026-06-07T00:00:04.000Z'
        )
      `;

      yield* recovery.recover();
      yield* engine.answerTicketStep({
        stepRunId,
        text: "Continue after restart.",
      });
      const done = yield* waitForDetail(
        read,
        ticketId,
        (detail) => detail?.ticket.currentLaneKey === "done",
        "provider restart completion",
      );
      if (done === null) {
        assert.fail("Expected completed provider restart detail");
      }
      const calls = yield* provider.calls;
      const responses = yield* provider.responses;

      assert.equal(done.ticket.currentLaneKey, "done");
      assert.equal(calls.length, 1);
      assert.deepEqual(
        responses.map((response) => response.requestId),
        [requestId],
      );
      assert.deepEqual(
        responses.map((response) => response.responseKind),
        ["user-input"],
      );
      assert.deepEqual(
        responses.map((response) => response.text),
        ["Continue after restart."],
      );
    }).pipe(Effect.provide(TestLayer)),
  );
});
