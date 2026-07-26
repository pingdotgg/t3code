import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type ProviderSessionRuntimeStatus,
  type TerminalCloseInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Duration from "effect/Duration";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadArchiveReactor } from "../Services/ThreadArchiveReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ThreadArchiveReactorLive } from "./ThreadArchiveReactor.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const createdAt = "2026-01-01T00:00:00.000Z";
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const unsupported = () => Effect.die("unsupported in thread archive reactor test");

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

const waitFor = (
  predicate: () => boolean,
  timeout: Duration.Input = "5 seconds",
): Effect.Effect<void, WaitForConditionError> =>
  Effect.sync(predicate).pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

interface ArchiveHarnessCalls {
  readonly interrupted: Array<ThreadId>;
  readonly closedTerminals: Array<TerminalCloseInput>;
  readonly events: Array<OrchestrationEvent>;
}

async function createArchiveHarness(input?: {
  readonly bindings?: Readonly<Record<string, ProviderSessionRuntimeStatus>>;
}) {
  const calls: ArchiveHarnessCalls = {
    interrupted: [],
    closedTerminals: [],
    events: [],
  };
  const bindings = new Map<string, ProviderRuntimeBinding>(
    Object.entries(input?.bindings ?? {}).map(([threadId, status]) => [
      threadId,
      {
        threadId: ThreadId.make(threadId),
        provider: ProviderDriverKind.make("codex"),
        status,
      },
    ]),
  );

  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: (request) =>
      Effect.sync(() => {
        calls.interrupted.push(request.threadId);
      }),
    stopTask: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => unsupported(),
    getInstanceInfo: () => unsupported(),
    rollbackConversation: () => unsupported(),
    streamEvents: Stream.empty,
  };

  const providerSessionDirectory: ProviderSessionDirectoryShape = {
    upsert: () => unsupported(),
    getProvider: () => unsupported(),
    getBinding: (threadId) => Effect.succeed(Option.fromNullishOr(bindings.get(threadId))),
    listThreadIds: () => unsupported(),
    listBindings: () => unsupported(),
  };

  const terminalManagerLayer = Layer.succeed(TerminalManager.TerminalManager, {
    open: () => unsupported(),
    attachStream: () => unsupported(),
    write: () => unsupported(),
    resize: () => unsupported(),
    clear: () => unsupported(),
    restart: () => unsupported(),
    close: (closeInput) =>
      Effect.sync(() => {
        calls.closedTerminals.push(closeInput);
      }),
    subscribe: () => unsupported(),
    subscribeMetadata: () => unsupported(),
  } satisfies TerminalManager.TerminalManager["Service"]);

  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-thread-archive-reactor-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  const reactorLayer = ThreadArchiveReactorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        orchestrationLayer,
        Layer.succeed(ProviderService, providerService),
        Layer.succeed(ProviderSessionDirectory, providerSessionDirectory),
        terminalManagerLayer,
      ),
    ),
  );

  const runtime = ManagedRuntime.make(Layer.mergeAll(reactorLayer, orchestrationLayer));
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const archiveReactor = await runtime.runPromise(Effect.service(ThreadArchiveReactor));

  const scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(archiveReactor.start().pipe(Scope.provide(scope)));
  await Effect.runPromise(
    Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        Effect.sync(() => {
          calls.events.push(event);
        }),
      ),
    ).pipe(Scope.provide(scope)),
  );

  const createProject = (projectId: string) =>
    runtime.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`cmd-${projectId}-create`),
        projectId: asProjectId(projectId),
        title: projectId,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection,
        createdAt,
      }),
    );

  const createThread = (input: {
    readonly commandId: string;
    readonly threadId: string;
    readonly projectId: string;
    readonly parentThreadId?: string;
  }) =>
    runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(input.commandId),
        threadId: ThreadId.make(input.threadId),
        projectId: asProjectId(input.projectId),
        title: input.threadId,
        modelSelection: defaultModelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        parentThreadId: input.parentThreadId ? ThreadId.make(input.parentThreadId) : null,
        createdAt,
      }),
    );

  const archivedThreadIds = () =>
    calls.events
      .filter((event) => event.type === "thread.archived")
      .map((event) => event.payload.threadId as ThreadId);
  const sessionStopRequestedThreadIds = () =>
    calls.events
      .filter((event) => event.type === "thread.session-stop-requested")
      .map((event) => event.payload.threadId as ThreadId);

  return {
    calls,
    engine,
    archiveReactor,
    createProject,
    createThread,
    archivedThreadIds,
    sessionStopRequestedThreadIds,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}

describe("ThreadArchiveReactor", () => {
  let harness: Awaited<ReturnType<typeof createArchiveHarness>> | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.dispose();
    }
    harness = null;
  });

  it("interrupts and stops sessions, closes terminals, and cascades archive to child threads", async () => {
    harness = await createArchiveHarness({
      bindings: {
        "thread-parent": "running",
        "thread-child": "running",
      },
    });
    await harness.createProject("project-archive");
    await harness.createThread({
      commandId: "cmd-parent-create",
      threadId: "thread-parent",
      projectId: "project-archive",
    });
    await harness.createThread({
      commandId: "cmd-child-create",
      threadId: "thread-child",
      projectId: "project-archive",
      parentThreadId: "thread-parent",
    });

    await harness.run(
      harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-parent-archive"),
        threadId: ThreadId.make("thread-parent"),
      }),
    );

    await harness.run(
      waitFor(
        () =>
          harness!.archivedThreadIds().includes(ThreadId.make("thread-child")) &&
          harness!.sessionStopRequestedThreadIds().includes(ThreadId.make("thread-child")) &&
          harness!.calls.closedTerminals.some(
            (input) => input.threadId === ThreadId.make("thread-child"),
          ),
      ),
    );

    const parent = ThreadId.make("thread-parent");
    const child = ThreadId.make("thread-child");
    expect(harness.archivedThreadIds()).toEqual([parent, child]);
    expect(harness.sessionStopRequestedThreadIds()).toEqual([parent, child]);
    expect(harness.calls.interrupted).toEqual([parent, child]);
    expect(
      harness.calls.closedTerminals.every(
        (input) => input.deleteHistory === undefined || input.deleteHistory === false,
      ),
    ).toBe(true);

    const childArchiveEvent = harness.calls.events.find(
      (event) => event.type === "thread.archived" && event.payload.threadId === child,
    );
    expect(childArchiveEvent?.commandId).toBe(
      CommandId.make("archive-cascade:cmd-parent-archive:thread-child"),
    );
  });

  it("skips turn interrupt and session stop when the session binding is already stopped", async () => {
    harness = await createArchiveHarness({
      bindings: {
        "thread-parent": "stopped",
      },
    });
    await harness.createProject("project-archive-stopped");
    await harness.createThread({
      commandId: "cmd-stopped-parent-create",
      threadId: "thread-parent",
      projectId: "project-archive-stopped",
    });

    await harness.run(
      harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-stopped-parent-archive"),
        threadId: ThreadId.make("thread-parent"),
      }),
    );

    await harness.run(
      waitFor(() =>
        harness!.calls.closedTerminals.some(
          (input) => input.threadId === ThreadId.make("thread-parent"),
        ),
      ),
    );
    await harness.run(harness.archiveReactor.drain);

    expect(harness.calls.interrupted).toEqual([]);
    expect(harness.sessionStopRequestedThreadIds()).toEqual([]);
  });

  it("does not re-archive an already-archived child when the parent archive cascades", async () => {
    harness = await createArchiveHarness({
      bindings: {
        "thread-parent": "running",
        "thread-child": "stopped",
      },
    });
    await harness.createProject("project-archive-idempotent");
    await harness.createThread({
      commandId: "cmd-idem-parent-create",
      threadId: "thread-parent",
      projectId: "project-archive-idempotent",
    });
    await harness.createThread({
      commandId: "cmd-idem-child-create",
      threadId: "thread-child",
      projectId: "project-archive-idempotent",
      parentThreadId: "thread-parent",
    });

    // The child was already archived (e.g. auto-archive of a completed
    // sub-agent) before the parent archive.
    await harness.run(
      harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-child-archive-first"),
        threadId: ThreadId.make("thread-child"),
      }),
    );
    await harness.run(
      waitFor(() => harness!.archivedThreadIds().includes(ThreadId.make("thread-child"))),
    );
    await harness.run(harness.archiveReactor.drain);

    await harness.run(
      harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-parent-archive-idem"),
        threadId: ThreadId.make("thread-parent"),
      }),
    );
    await harness.run(
      waitFor(() =>
        harness!.calls.closedTerminals.some(
          (input) => input.threadId === ThreadId.make("thread-parent"),
        ),
      ),
    );
    await harness.run(harness.archiveReactor.drain);

    // The cascade must skip the already-archived child: exactly one archived
    // event and one terminal close per thread, and a duplicate archive of the
    // child would have been rejected by the decider instead of looping.
    expect(
      harness.archivedThreadIds().filter((threadId) => threadId === ThreadId.make("thread-child")),
    ).toHaveLength(1);
    expect(
      harness.calls.closedTerminals.filter(
        (input) => input.threadId === ThreadId.make("thread-child"),
      ),
    ).toHaveLength(1);
    expect(harness.archivedThreadIds()).toContain(ThreadId.make("thread-parent"));
  });
});
