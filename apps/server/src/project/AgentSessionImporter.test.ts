import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeProviderSessionDirectoryLive,
  ProviderSessionDirectoryLive,
} from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryPersistenceError } from "../provider/Errors.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const PROJECT_ID = ProjectId.make("project-1");
const WORKSPACE_ROOT = "/tmp/project-from-server";
const CLAUDE_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

const makeThread = (source: "codex" | "claudeAgent"): AgentSessionScanner.AgentSessionThread => ({
  source,
  providerInstanceId: ProviderInstanceId.make(source),
  providerSessionId: source === "codex" ? "codex-session" : CLAUDE_SESSION_ID,
  title: `Imported ${source} thread`,
  model: null,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:01:00.000Z",
  messages: [
    { role: "user", text: "Fix the bug", createdAt: "2026-08-24T10:00:00.000Z" },
    { role: "assistant", text: "Fixed", createdAt: "2026-08-24T10:01:00.000Z" },
  ],
});

const makeProject = (): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: WORKSPACE_ROOT,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-24T09:00:00.000Z",
  updatedAt: "2026-08-24T09:00:00.000Z",
});

const makeProjectedThread = (input: {
  readonly source: "codex" | "claudeAgent";
  readonly projectId?: ProjectId;
  readonly imported?: boolean;
  readonly includeFollowup?: boolean;
}): OrchestrationThread => {
  const sourceThread = makeThread(input.source);
  const threadId = ThreadId.make(
    `import:${sourceThread.providerInstanceId}:${sourceThread.providerSessionId}`,
  );
  return {
    id: threadId,
    projectId: input.projectId ?? PROJECT_ID,
    title: sourceThread.title,
    modelSelection: { instanceId: sourceThread.providerInstanceId, model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: sourceThread.createdAt,
    updatedAt: sourceThread.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: input.imported
      ? [
          {
            id: MessageId.make(`${threadId}:000000`),
            role: "user",
            text: "Fix the bug",
            turnId: null,
            streaming: false,
            createdAt: "2026-08-24T10:00:00.000Z",
            updatedAt: "2026-08-24T10:00:00.000Z",
          },
          ...(input.includeFollowup
            ? [
                {
                  id: MessageId.make("user-followup"),
                  role: "user" as const,
                  text: "Keep going",
                  turnId: null,
                  streaming: false,
                  createdAt: "2026-08-24T10:02:00.000Z",
                  updatedAt: "2026-08-24T10:02:00.000Z",
                },
              ]
            : []),
        ]
      : [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
};

const makeSnapshotsLayer = (input: {
  readonly project?: OrchestrationProjectShell;
  readonly getThread?: (threadId: ThreadId) => Option.Option<OrchestrationThread>;
}) =>
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getProjectShellById: () =>
      Effect.succeed(input.project === undefined ? Option.none() : Option.some(input.project)),
    getThreadDetailById: (threadId) => Effect.succeed(input.getThread?.(threadId) ?? Option.none()),
  });

const runImport = (input: {
  readonly scanner: AgentSessionScanner.AgentSessionScanner["Service"];
  readonly engine: OrchestrationEngine.OrchestrationEngineService["Service"];
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  readonly snapshots: ReturnType<typeof makeSnapshotsLayer>;
}) =>
  importRecentAgentThreads({ projectId: PROJECT_ID }).pipe(
    Effect.provideService(AgentSessionScanner.AgentSessionScanner, input.scanner),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, input.engine),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, input.directory),
    Effect.provide(input.snapshots),
  );

it.layer(NodeServices.layer)("AgentSessionImporter", (it) => {
  describe("importRecentAgentThreads", () => {
    it.effect("uses the project root and stores provider-specific resume cursors", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        const bindings: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
        let scannedRoot: string | undefined;
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: (workspaceRoot) => {
            scannedRoot = workspaceRoot;
            return Stream.concat(
              Stream.succeed(makeThread("codex")),
              Stream.fromEffect(
                Effect.sync(() => {
                  expect(bindings).toHaveLength(1);
                  return makeThread("claudeAgent");
                }),
              ),
            );
          },
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) => Effect.sync(() => ({ sequence: commands.push(command) })),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: (binding) => Effect.sync(() => void bindings.push(binding)),
          getProvider: () => Effect.die("unused"),
          getBinding: () => Effect.succeed(Option.none()),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.die("unused"),
        });

        const result = yield* runImport({
          scanner,
          engine,
          directory,
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
        });

        expect(result).toEqual({ importedCount: 2, skippedCount: 0 });
        expect(scannedRoot).toBe(WORKSPACE_ROOT);
        expect(commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.history.import",
          "thread.create",
          "thread.history.import",
        ]);
        expect(
          commands
            .filter((command) => command.type === "thread.history.import")
            .flatMap((command) => command.messages.map((message) => message.messageId)),
        ).toEqual([
          "import:codex:codex-session:000000",
          "import:codex:codex-session:000001",
          `import:claudeAgent:${CLAUDE_SESSION_ID}:000000`,
          `import:claudeAgent:${CLAUDE_SESSION_ID}:000001`,
        ]);
        expect(bindings).toMatchObject([
          {
            provider: "codex",
            providerInstanceId: "codex",
            resumeCursor: { threadId: "codex-session" },
            runtimePayload: { cwd: WORKSPACE_ROOT },
          },
          {
            provider: "claudeAgent",
            providerInstanceId: "claudeAgent",
            resumeCursor: {
              threadId: `import:claudeAgent:${CLAUDE_SESSION_ID}`,
              resume: CLAUDE_SESSION_ID,
            },
            runtimePayload: { cwd: WORKSPACE_ROOT },
          },
        ]);
      }),
    );

    it.effect("recovers after a rejected history receipt and a failed binding write", () =>
      Effect.gen(function* () {
        let threadCreated = false;
        let historyImported = false;
        let historyAttemptCount = 0;
        let bindingAttemptCount = 0;
        const rejectedCommandIds = new Set<string>();
        const bindings: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () => Stream.fromIterable([makeThread("codex")]),
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) => {
            if (rejectedCommandIds.has(command.commandId)) {
              return Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Previously rejected.",
                }),
              );
            }
            if (command.type === "thread.create") threadCreated = true;
            if (command.type === "thread.history.import") {
              historyAttemptCount += 1;
              if (historyAttemptCount === 1) {
                rejectedCommandIds.add(command.commandId);
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "Temporary history import failure.",
                  }),
                );
              }
              historyImported = true;
            }
            return Effect.succeed({ sequence: 1 });
          },
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: (binding) => {
            bindingAttemptCount += 1;
            if (bindingAttemptCount === 1) {
              return Effect.fail(
                new ProviderSessionDirectoryPersistenceError({
                  operation: "upsert",
                  detail: "Temporary session storage failure.",
                }),
              );
            }
            bindings.push(binding);
            return Effect.void;
          },
          getProvider: () => Effect.die("unused"),
          getBinding: () =>
            Effect.succeed(bindings[0] === undefined ? Option.none() : Option.some(bindings[0])),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.die("unused"),
        });
        const snapshots = makeSnapshotsLayer({
          project: makeProject(),
          getThread: () =>
            threadCreated
              ? Option.some(makeProjectedThread({ source: "codex", imported: historyImported }))
              : Option.none(),
        });
        const importOnce = () => runImport({ scanner, engine, directory, snapshots });

        expect(yield* importOnce()).toEqual({ importedCount: 0, skippedCount: 1 });
        expect(yield* importOnce()).toEqual({ importedCount: 0, skippedCount: 1 });
        expect(yield* importOnce()).toEqual({ importedCount: 1, skippedCount: 0 });
        const historyAttemptsAfterCompletion = historyAttemptCount;
        expect(yield* importOnce()).toEqual({ importedCount: 1, skippedCount: 0 });
        expect(historyAttemptCount).toBe(historyAttemptsAfterCompletion);
        expect(historyAttemptCount).toBe(2);
        expect(bindings).toHaveLength(1);
      }),
    );

    it.effect("does not replace completed history or an active binding on retry", () =>
      Effect.gen(function* () {
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () => Stream.fromIterable([makeThread("codex")]),
        });
        const runningBinding: ProviderSessionDirectory.ProviderRuntimeBinding = {
          threadId: ThreadId.make("import:codex:codex-session"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          resumeCursor: { threadId: "newer-codex-session" },
        };
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: () => Effect.die("must not replace an active binding"),
          getProvider: () => Effect.die("unused"),
          getBinding: () => Effect.succeed(Option.some(runningBinding)),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.die("unused"),
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: () => Effect.die("must not replay history or settle active work"),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        });

        const result = yield* runImport({
          scanner,
          engine,
          directory,
          snapshots: makeSnapshotsLayer({
            project: makeProject(),
            getThread: () =>
              Option.some(
                makeProjectedThread({ source: "codex", imported: true, includeFollowup: true }),
              ),
          }),
        });

        expect(result).toEqual({ importedCount: 1, skippedCount: 0 });
      }),
    );

    it.effect("skips malformed Claude ids and wrong-project thread collisions", () =>
      Effect.gen(function* () {
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () =>
            Stream.fromIterable([
              { ...makeThread("claudeAgent"), providerSessionId: "not-a-uuid" },
              makeThread("codex"),
            ]),
        });
        const commands: Array<OrchestrationCommand> = [];
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) => Effect.sync(() => ({ sequence: commands.push(command) })),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: () => Effect.void,
          getProvider: () => Effect.die("unused"),
          getBinding: () => Effect.succeed(Option.none()),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.die("unused"),
        });

        const result = yield* runImport({
          scanner,
          engine,
          directory,
          snapshots: makeSnapshotsLayer({
            project: makeProject(),
            getThread: (threadId) =>
              threadId === "import:codex:codex-session"
                ? Option.some(
                    makeProjectedThread({
                      source: "codex",
                      projectId: ProjectId.make("project-other"),
                    }),
                  )
                : Option.none(),
          }),
        });

        expect(result).toEqual({ importedCount: 0, skippedCount: 2 });
        expect(commands).toHaveLength(0);
      }),
    );
  });
});

const integrationThread = {
  ...makeThread("codex"),
  updatedAt: "2026-08-24T10:00:00.000Z",
  messages: Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `Message ${index}`,
    createdAt: "2026-08-24T10:00:00.000Z",
  })),
};
const integrationScanner = AgentSessionScanner.AgentSessionScanner.of({
  scan: Effect.die("unused"),
  recentThreads: () => Stream.fromIterable([integrationThread]),
});
const integrationServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-agent-session-importer-test-",
});
const integrationRuntimeRepository = ProviderSessionRuntime.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const integrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  integrationRuntimeRepository,
  ProviderSessionDirectoryLive.pipe(Layer.provide(integrationRuntimeRepository)),
  Layer.succeed(AgentSessionScanner.AgentSessionScanner, integrationScanner),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(integrationServerConfig),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(integrationLayer)("AgentSessionImporter integration", (it) => {
  it.effect("imports once after the real engine persists an old rejected receipt", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = ThreadId.make("import:codex:codex-session");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-import-integration-project"),
        projectId: PROJECT_ID,
        title: "Project",
        workspaceRoot: WORKSPACE_ROOT,
        defaultModelSelection: null,
        createdAt: "2026-08-24T09:00:00.000Z",
      });
      const rejected = yield* Effect.result(
        engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make(`agent-session:history:${threadId}`),
          threadId,
          messages: [
            {
              messageId: MessageId.make(`${threadId}:000000`),
              role: "user",
              text: "Fix the bug",
              createdAt: "2026-08-24T10:00:00.000Z",
            },
          ],
        }),
      );
      expect(rejected._tag).toBe("Failure");

      const result = yield* importRecentAgentThreads({ projectId: PROJECT_ID });
      const importedThread = yield* snapshots.getThreadDetailById(threadId);
      const binding = yield* directory.getBinding(threadId);

      expect(result).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(Option.getOrThrow(importedThread).messages.map((message) => message.text)).toEqual(
        integrationThread.messages.map((message) => message.text),
      );
      expect(Option.getOrThrow(importedThread).settledOverride).toBe("settled");
      expect(Option.getOrThrow(importedThread).updatedAt).toBe("2026-08-24T10:00:00.000Z");
      expect(Option.getOrThrow(binding)).toMatchObject({
        provider: "codex",
        providerInstanceId: "codex",
        resumeCursor: { threadId: "codex-session" },
        runtimePayload: { cwd: WORKSPACE_ROOT },
      });

      yield* engine.dispatch({
        type: "thread.revert.complete",
        commandId: CommandId.make("revert-imported-thread-to-baseline"),
        threadId,
        turnCount: 0,
        createdAt: "2026-08-24T10:05:00.000Z",
      });
      const afterRevert = yield* snapshots.getThreadDetailById(threadId);
      expect(Option.getOrThrow(afterRevert).messages.map((message) => message.text)).toEqual(
        integrationThread.messages.map((message) => message.text),
      );
    }),
  );

  it.effect("keeps a binding created while an import is in progress", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const projectId = ProjectId.make("project-import-binding-race");
      const workspaceRoot = "/tmp/project-import-binding-race";
      const providerSessionId = "codex-binding-race";
      const threadId = ThreadId.make(`import:codex:${providerSessionId}`);
      const scanner = AgentSessionScanner.AgentSessionScanner.of({
        scan: Effect.die("unused"),
        recentThreads: () =>
          Stream.succeed({ ...integrationThread, providerSessionId, title: "Binding race" }),
      });
      const importerAtBindingWrite = yield* Deferred.make<void>();
      const releaseImporter = yield* Deferred.make<void>();
      const importerRepository = ProviderSessionRuntime.ProviderSessionRuntimeRepository.of({
        ...repository,
        upsert: (runtime, options) =>
          options?.onConflict === "ignore"
            ? Deferred.succeed(importerAtBindingWrite, undefined).pipe(
                Effect.andThen(Deferred.await(releaseImporter)),
                Effect.andThen(repository.upsert(runtime, options)),
              )
            : repository.upsert(runtime, options),
      });
      const importerDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory.pipe(
        Effect.provide(
          makeProviderSessionDirectoryLive().pipe(
            Layer.provide(
              Layer.succeed(
                ProviderSessionRuntime.ProviderSessionRuntimeRepository,
                importerRepository,
              ),
            ),
          ),
        ),
      );

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-import-binding-race-project"),
        projectId,
        title: "Binding race",
        workspaceRoot,
        defaultModelSelection: null,
        createdAt: "2026-08-24T09:00:00.000Z",
      });

      const importFiber = yield* importRecentAgentThreads({ projectId }).pipe(
        Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
        Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, importerDirectory),
        Effect.forkChild,
      );

      yield* Effect.raceFirst(
        Deferred.await(importerAtBindingWrite),
        Fiber.join(importFiber).pipe(
          Effect.flatMap((result) =>
            Effect.die(
              new Error(`Import completed before the binding write: ${JSON.stringify(result)}`),
            ),
          ),
        ),
      );
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId)).messages.map(
          (message) => message.text,
        ),
      ).toEqual(integrationThread.messages.map((message) => message.text));

      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        resumeCursor: { threadId: "active-client-session" },
        runtimePayload: { cwd: workspaceRoot, activeTurnId: "turn-active" },
      });
      yield* Deferred.succeed(releaseImporter, undefined);

      expect(yield* Fiber.join(importFiber)).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(Option.getOrThrow(yield* directory.getBinding(threadId))).toMatchObject({
        status: "running",
        resumeCursor: { threadId: "active-client-session" },
        runtimePayload: { cwd: workspaceRoot, activeTurnId: "turn-active" },
      });
    }),
  );
});
