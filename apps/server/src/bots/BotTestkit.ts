import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  type RunId,
  type ThreadBotConfig,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BotService from "./BotService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HomeService from "../home/HomeService.ts";

export const model: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};

export interface SentMessage {
  readonly threadId: ThreadId;
  readonly commandId: string;
  readonly text: string;
}

/** The thread fields Bots and Home read; tests change them in place. */
export interface FakeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: "full-access";
  readonly lineage: { readonly parentThreadId: ThreadId | null };
  botConfig: ThreadBotConfig | null;
  groupedUnderThreadId: ThreadId | null;
  activeRunId: RunId | null;
  settledOverride: "settled" | null;
  archivedAt: string | null;
  deletedAt: null;
}

export interface LaunchedThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly text: string | undefined;
}

/** The orchestration Bots and Home drive, recording what they were asked to do. */
export const makeOrchestration = () => {
  const threads = new Map<ThreadId, FakeThread>();
  const dispatched: Array<OrchestrationV2ServerCommand & { readonly threadId?: ThreadId }> = [];
  const sent: Array<SentMessage> = [];
  const launched: Array<LaunchedThread> = [];

  const addThread = (id: string, fields: Partial<Omit<FakeThread, "id">> = {}): FakeThread => {
    const thread: FakeThread = {
      id: ThreadId.make(id),
      projectId: ProjectId.make("project:a"),
      title: id,
      modelSelection: model,
      runtimeMode: "full-access",
      lineage: { parentThreadId: null },
      botConfig: null,
      groupedUnderThreadId: null,
      activeRunId: null,
      settledOverride: null,
      archivedAt: null,
      deletedAt: null,
      ...fields,
    };
    threads.set(thread.id, thread);
    return thread;
  };
  const asAppThread = (thread: FakeThread | undefined) =>
    (thread ?? null) as OrchestrationV2AppThread | null;

  const layer = Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          const threadId = input.threadId!;
          addThread(threadId, {
            projectId: input.projectId,
            title: input.title,
            botConfig: input.botConfig ?? null,
          });
          launched.push({ threadId, projectId: input.projectId, text: input.initialMessage?.text });
          return { threadId } as ThreadLaunchService.ThreadLaunchResult;
        }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed((threads.get(threadId) ?? null) as never),
      getThreadProjection: (threadId) => {
        const thread = threads.get(threadId);
        return thread === undefined
          ? Effect.die(`no thread ${threadId}`)
          : Effect.succeed({ thread, runs: [], attempts: [] } as never);
      },
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command as never);
          if (command.type === "thread.metadata.update" && command.groupedUnderThreadId) {
            threads.get(command.threadId)!.groupedUnderThreadId = command.groupedUnderThreadId;
          }
          return { sequence: dispatched.length, storedEvents: [] };
        }),
      sendToThread: (input) =>
        Effect.sync(() => {
          sent.push({ threadId: input.threadId, commandId: input.commandId, text: input.text });
          return {} as ThreadManagementService.ThreadManagementSendResult;
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      findThread: (threadId) => Effect.succeed(asAppThread(threads.get(threadId))),
      listGroupedCrewIds: (threadId) =>
        Effect.succeed(
          [...threads.values()]
            .filter((thread) => thread.groupedUnderThreadId === threadId)
            .map((thread) => thread.id),
        ),
      getThreadRecords: () => Effect.succeed({ turnItems: [] } as never),
    }),
    Layer.mock(ProjectService.ProjectService)({
      bootstrap: (input) =>
        Effect.succeed({ project: { id: input.projectId }, created: true } as never),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env:here")),
    }),
  );
  return { threads, dispatched, sent, launched, addThread, layer };
};

/** Home and the Bot service over one fake orchestration and a fresh base directory. */
export const provideBots = (orchestration: ReturnType<typeof makeOrchestration>) =>
  Effect.provide(
    HomeService.layer.pipe(
      Layer.provideMerge(BotService.layer),
      Layer.provideMerge(orchestration.layer),
      Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bots-test-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
