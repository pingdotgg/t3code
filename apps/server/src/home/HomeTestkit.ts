import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ModelSelection,
  ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HomeService from "./HomeService.ts";

export const model: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};

export interface SentMessage {
  readonly threadId: ThreadId;
  readonly commandId: string;
  readonly text: string;
}

interface FakeShell {
  readonly id: ThreadId;
  readonly projectId: string;
  activeRunId: RunId | null;
  readonly deletedAt: null;
  readonly archivedAt: null;
}

/** The orchestration Home drives, recording what it was asked to do. */
export const makeOrchestration = (sends?: Queue.Queue<SentMessage>) => {
  const shells = new Map<ThreadId, FakeShell>();
  const dispatched: Array<{ readonly type: string; readonly threadId?: ThreadId }> = [];
  const sent: Array<SentMessage> = [];
  const layer = Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          const threadId = input.threadId!;
          shells.set(threadId, {
            id: threadId,
            projectId: input.projectId,
            activeRunId: null,
            deletedAt: null,
            archivedAt: null,
          });
          return { threadId } as ThreadLaunchService.ThreadLaunchResult;
        }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed((shells.get(threadId) ?? null) as never),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command as never);
          return { sequence: dispatched.length, storedEvents: [] };
        }),
      sendToThread: Effect.fn("FakeThreads.sendToThread")(function* (input) {
        const message = {
          threadId: input.threadId,
          commandId: input.commandId,
          text: input.text,
        };
        sent.push(message);
        if (sends !== undefined) yield* Queue.offer(sends, message);
        return {} as ThreadManagementService.ThreadManagementSendResult;
      }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      bootstrap: (input) =>
        Effect.succeed({ project: { id: input.projectId }, created: true } as never),
    }),
  );
  return { shells, dispatched, sent, layer };
};

export const provideHome = (orchestration: ReturnType<typeof makeOrchestration>) =>
  Effect.provide(
    HomeService.layer.pipe(
      Layer.provideMerge(orchestration.layer),
      Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-home-test-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
