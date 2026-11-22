import {
  BotError,
  CommandId,
  type BotCreateInput,
  type BotProfile,
  type BotRestoreInput,
  type BotSetStateInput,
  type BotUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SecureRandom from "effect/crypto/SecureRandom";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as BotStore from "./BotStore.ts";

type BotOperation<Input> = (input: Input) => Effect.Effect<BotProfile, BotError>;

export class BotService extends Context.Service<
  BotService,
  {
    readonly create: BotOperation<typeof BotCreateInput.Type>;
    readonly update: BotOperation<typeof BotUpdateInput.Type>;
    readonly setState: BotOperation<typeof BotSetStateInput.Type>;
    readonly restore: BotOperation<typeof BotRestoreInput.Type>;
  }
>()("t3/bots/BotService") {}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const orchestration = yield* Orchestrator.OrchestratorV2;
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const bots = yield* BotStore.BotStore;
  const threads = yield* ThreadLaunch.ThreadLaunchService;
  const config = yield* ServerConfig.ServerConfig;
  const providers = yield* ProviderInstances.ProviderInstanceRegistry;

  const create = Effect.fn("BotService.create")(function* (input: typeof BotCreateInput.Type) {
    const threadId = ThreadId.make(`bot:${input.commandId}`);
    const existing = yield* bots.find(threadId);
    if (existing !== undefined) {
      if (existing.projectId !== input.projectId)
        return yield* new BotError({ reason: "conflict" });
      return existing;
    }
    const provider = yield* providers.getInstance(input.modelSelection.instanceId);
    const replay = config.devUrl !== undefined && input.modelSelection.instanceId === "devReplay";
    if (provider === undefined || (provider.driverKind !== "codex" && !replay)) {
      return yield* new BotError({ reason: "unsupported_provider" });
    }
    yield* threads
      .launch({
        commandId: input.commandId,
        threadId,
        projectId: input.projectId,
        title: input.profile.name,
        titleRenamed: true,
        modelSelection: input.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError((cause) => new BotError({ reason: "unavailable", cause })));
    return yield* bots.create({
      ...input.profile,
      projectId: input.projectId,
      threadId,
      state: "active",
      access: { writeSources: [], handoffProjects: [] },
      revision: 1,
    });
  });

  const update = Effect.fn("BotService.update")(function* (input: typeof BotUpdateInput.Type) {
    return yield* bots.update(input.threadId, input.expectedRevision, input.profile);
  });

  const setState = Effect.fn("BotService.setState")(function* (
    input: typeof BotSetStateInput.Type,
  ) {
    const bot = yield* bots.setState(input.threadId, input.state);
    if (input.state === "archived") {
      const { tasks } = yield* scheduled
        .list()
        .pipe(Effect.mapError((cause) => new BotError({ reason: "unavailable", cause })));
      for (const task of tasks) {
        if (task.threadId === bot.threadId && task.enabled) {
          yield* scheduled
            .setEnabled({ id: task.id, enabled: false })
            .pipe(Effect.mapError((cause) => new BotError({ reason: "unavailable", cause })));
        }
      }
    }
    if (input.state === "active") {
      const id = yield* random.uuidV4();
      yield* orchestration
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`bot-resume:${id}`),
          threadId: input.threadId,
        })
        .pipe(Effect.mapError((cause) => new BotError({ reason: "unavailable", cause })));
    }
    return bot;
  });

  const restore = Effect.fn("BotService.restore")(function* (input: typeof BotRestoreInput.Type) {
    const history = yield* bots.history(input.threadId);
    const version = history.find(({ revision }) => revision === input.revision);
    if (!version) return yield* new BotError({ reason: "not_found" });
    const {
      threadId,
      projectId: _projectId,
      revision: _revision,
      state: _state,
      access: _access,
      ...profile
    } = version;
    return yield* bots.update(threadId, input.expectedRevision, profile);
  });

  return BotService.of({ create, update, setState, restore });
});

export const layer = Layer.effect(BotService, make);
