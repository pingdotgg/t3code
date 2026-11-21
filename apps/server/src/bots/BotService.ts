import {
  Bot,
  BotGroup,
  BotGroupId,
  BotGroupMessage,
  BotGroupMessageId,
  BotId,
  BotItem,
  BotItemId,
  BotOperationError,
  BotRoutine,
  BotRoutineId,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  type BotsCreateGroupInput,
  type BotsCreateInput,
  type BotsCreateItemInput,
  type BotsDeleteGroupInput,
  type BotsDeleteGroupResult,
  type BotsDeleteInput,
  type BotsDeleteItemInput,
  type BotsDeleteItemResult,
  type BotsDeleteResult,
  type BotsDeleteRoutineInput,
  type BotsDeleteRoutineResult,
  type BotsGetInput,
  type BotsHandoffInput,
  type BotsHandoffResult,
  type BotsImportFolderInput,
  type BotsListFilesInput,
  type BotsListFilesResult,
  type BotsListGroupMessagesInput,
  type BotsListGroupMessagesResult,
  type BotsListGroupsResult,
  type BotsListItemsInput,
  type BotsListItemsResult,
  type BotsListResult,
  type BotsListRoutinesInput,
  type BotsListRoutinesResult,
  type BotsOpenChatInput,
  type BotsOpenChatResult,
  type BotsReadFileInput,
  type BotsReadFileResult,
  type BotsRunRoutineNowInput,
  type BotsRunRoutineNowResult,
  type BotsSendGroupMessageInput,
  type BotsSendGroupMessageResult,
  type BotsUpdateGroupInput,
  type BotsUpdateInput,
  type BotsUpdateItemInput,
  type BotsUpsertRoutineInput,
  type BotsWriteFileInput,
  type BotsWriteFileResult,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScheduledTaskSchedule,
  type ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import {
  allocateUniqueSlug,
  buildFirstRunInterviewPrompt,
  buildTidyUpPrompt,
  ensureBotHomeDirectory,
  importBotFolder,
  listBotHomeFiles,
  parseGroupMentions,
  readBotHomeFile,
  removeBotHomeDirectory,
  sha256Hex,
  writeBotHomeFile,
} from "./BotHome.ts";
import * as BotRepository from "./BotRepository.ts";

const decodeBotId = Schema.decodeUnknownSync(BotId);
const decodeBotRoutineId = Schema.decodeUnknownSync(BotRoutineId);
const decodeBotGroupId = Schema.decodeUnknownSync(BotGroupId);
const decodeBotGroupMessageId = Schema.decodeUnknownSync(BotGroupMessageId);
const decodeBotItemId = Schema.decodeUnknownSync(BotItemId);
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeCommandId = Schema.decodeUnknownSync(CommandId);
const decodeMessageId = Schema.decodeUnknownSync(MessageId);
const decodeIsoDateTime = Schema.decodeUnknownSync(IsoDateTime);
const decodeNonNegativeInt = Schema.decodeUnknownSync(NonNegativeInt);

const DAY_MS = 24 * 60 * 60 * 1000;

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: () => Effect.Effect<BotsListResult, BotOperationError>;
    readonly get: (input: BotsGetInput) => Effect.Effect<Bot, BotOperationError>;
    readonly create: (input: BotsCreateInput) => Effect.Effect<Bot, BotOperationError>;
    readonly update: (input: BotsUpdateInput) => Effect.Effect<Bot, BotOperationError>;
    readonly delete: (input: BotsDeleteInput) => Effect.Effect<BotsDeleteResult, BotOperationError>;
    readonly importFolder: (input: BotsImportFolderInput) => Effect.Effect<Bot, BotOperationError>;
    readonly openChat: (
      input: BotsOpenChatInput,
    ) => Effect.Effect<BotsOpenChatResult, BotOperationError>;
    readonly handoff: (
      input: BotsHandoffInput,
      callerLimits?: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
    ) => Effect.Effect<BotsHandoffResult, BotOperationError>;

    readonly listFiles: (
      input: BotsListFilesInput,
    ) => Effect.Effect<BotsListFilesResult, BotOperationError>;
    readonly readFile: (
      input: BotsReadFileInput,
    ) => Effect.Effect<BotsReadFileResult, BotOperationError>;
    readonly writeFile: (
      input: BotsWriteFileInput,
    ) => Effect.Effect<BotsWriteFileResult, BotOperationError>;

    readonly listRoutines: (
      input: BotsListRoutinesInput,
    ) => Effect.Effect<BotsListRoutinesResult, BotOperationError>;
    readonly upsertRoutine: (
      input: BotsUpsertRoutineInput,
    ) => Effect.Effect<BotRoutine, BotOperationError>;
    readonly deleteRoutine: (
      input: BotsDeleteRoutineInput,
    ) => Effect.Effect<BotsDeleteRoutineResult, BotOperationError>;
    readonly runRoutineNow: (
      input: BotsRunRoutineNowInput,
    ) => Effect.Effect<BotsRunRoutineNowResult, BotOperationError>;
    readonly runDueRoutines: () => Effect.Effect<number, BotOperationError>;

    readonly listGroups: () => Effect.Effect<BotsListGroupsResult, BotOperationError>;
    readonly createGroup: (
      input: BotsCreateGroupInput,
    ) => Effect.Effect<BotGroup, BotOperationError>;
    readonly updateGroup: (
      input: BotsUpdateGroupInput,
    ) => Effect.Effect<BotGroup, BotOperationError>;
    readonly deleteGroup: (
      input: BotsDeleteGroupInput,
    ) => Effect.Effect<BotsDeleteGroupResult, BotOperationError>;
    readonly listGroupMessages: (
      input: BotsListGroupMessagesInput,
    ) => Effect.Effect<BotsListGroupMessagesResult, BotOperationError>;
    readonly sendGroupMessage: (
      input: BotsSendGroupMessageInput,
      callerLimits?: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
    ) => Effect.Effect<BotsSendGroupMessageResult, BotOperationError>;

    readonly listItems: (
      input: BotsListItemsInput,
    ) => Effect.Effect<BotsListItemsResult, BotOperationError>;
    readonly createItem: (input: BotsCreateItemInput) => Effect.Effect<BotItem, BotOperationError>;
    readonly updateItem: (input: BotsUpdateItemInput) => Effect.Effect<BotItem, BotOperationError>;
    readonly deleteItem: (
      input: BotsDeleteItemInput,
    ) => Effect.Effect<BotsDeleteItemResult, BotOperationError>;
    readonly sweepStaleItems: () => Effect.Effect<number, BotOperationError>;
  }
>()("t3/bots/BotService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const repo = yield* BotRepository.BotRepository;
  const projectService = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const botsRoot = path.join(config.baseDir, "bots");

  const withHomeServices = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Digest.Digest>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Digest.Digest, digest),
    );

  const nowIso = Effect.fnUntraced(function* () {
    const millis = yield* Clock.currentTimeMillis;
    return decodeIsoDateTime(DateTime.formatIso(DateTime.makeUnsafe(millis)));
  });

  const requireBot = Effect.fn("BotService.requireBot")(function* (botId: BotId) {
    const found = yield* repo.getBot(botId);
    if (Option.isNone(found)) {
      return yield* new BotOperationError({ message: `Bot "${botId}" not found.` });
    }
    return found.value;
  });

  const resolveModelSelectionForBot = Effect.fn("BotService.resolveModelSelection")(function* (
    bot: Bot,
  ) {
    if (bot.modelSelection !== null) return bot.modelSelection;
    const providers = yield* providerRegistry.getProviders;
    const preferred =
      bot.providerInstanceId !== null
        ? providers.find((p) => p.instanceId === bot.providerInstanceId && p.enabled)
        : undefined;
    const candidate =
      preferred ??
      providers.find((p) => p.enabled && p.status === "ready" && p.models.length > 0) ??
      providers.find((p) => p.enabled && p.models.length > 0);
    const firstModel = candidate?.models[0];
    if (!candidate || !firstModel) {
      return yield* new BotOperationError({
        message: "No enabled provider with an available model is configured for this bot.",
      });
    }
    const selection: ModelSelection = {
      instanceId: candidate.instanceId,
      model: firstModel.slug,
    };
    return selection;
  });

  const computeNextRunIso = Effect.fnUntraced(function* (
    schedule: ScheduledTaskSchedule,
    enabled: boolean,
  ) {
    if (!enabled) return null;
    const millis = yield* Clock.currentTimeMillis;
    const from = DateTime.makeUnsafe(millis);
    const next = nextScheduledRunAt(schedule, from);
    return next === null ? null : decodeIsoDateTime(DateTime.formatIso(next));
  });

  const syncTidyUpRoutine = Effect.fn("BotService.syncTidyUpRoutine")(function* (bot: Bot) {
    const routines = yield* repo.listRoutinesByBot(bot.id);
    const existing = routines.find((r) => r.isTidyUp);
    const schedule: ScheduledTaskSchedule = {
      type: "fixed_time",
      timeOfDay: bot.tidyUpTimeOfDay,
    };
    const timestamp = yield* nowIso();
    const nextRunAt = yield* computeNextRunIso(schedule, bot.tidyUpEnabled && !bot.paused);

    if (existing) {
      const updated: BotRoutine = {
        ...existing,
        title: "Nightly memory tidy-up",
        prompt: buildTidyUpPrompt(bot.name),
        enabled: bot.tidyUpEnabled,
        schedule,
        nextRunAt,
        updatedAt: timestamp,
      };
      yield* repo.upsertRoutine(updated);
      return;
    }

    if (!bot.tidyUpEnabled) return;

    const id = yield* randomUuidV4;
    const routine: BotRoutine = {
      id: decodeBotRoutineId(`bot-routine-${id}`),
      botId: bot.id,
      title: "Nightly memory tidy-up",
      prompt: buildTidyUpPrompt(bot.name),
      enabled: true,
      schedule,
      precheckCommand: null,
      lastPrecheckHash: null,
      isTidyUp: true,
      nextRunAt,
      lastRunAt: null,
      lastRunStatus: "idle",
      lastRunError: null,
      lastRunThreadId: null,
      runCount: decodeNonNegativeInt(0),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    yield* repo.upsertRoutine(routine);
  });

  const createBackingProject = Effect.fn("BotService.createBackingProject")(function* (
    name: string,
    homePath: string,
  ) {
    const projectUuid = yield* randomUuidV4;
    const cmdUuid = yield* randomUuidV4;
    const projectId = decodeProjectId(`bot-proj-${projectUuid}`);
    yield* projectService
      .create({
        commandId: decodeCommandId(`cmd-${cmdUuid}`),
        projectId,
        title: `[Bot] ${name}`,
        workspaceRoot: homePath,
        createWorkspaceRootIfMissing: true,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new BotOperationError({
              message: `Failed to create backing project for bot "${name}": ${error.message}`,
            }),
        ),
      );
    return projectId;
  });

  const list = Effect.fn("BotService.list")(function* () {
    const bots = yield* repo.listBots();
    return { bots };
  });

  const get = Effect.fn("BotService.get")(function* (input: BotsGetInput) {
    return yield* requireBot(input.botId);
  });

  const create = Effect.fn("BotService.create")(function* (input: BotsCreateInput) {
    const existing = yield* repo.listBots();
    const usedSlugs = new Set<string>(existing.map((b) => b.slug));
    const slug = allocateUniqueSlug(input.slug ?? input.name, usedSlugs);
    const homePath = path.join(botsRoot, slug);

    yield* withHomeServices(
      ensureBotHomeDirectory({
        homePath,
        name: input.name,
        soulContent: input.soulContent,
      }),
    );

    const projectId = yield* createBackingProject(input.name, homePath);
    const timestamp = yield* nowIso();
    const id = yield* randomUuidV4;
    const bot: Bot = {
      id: decodeBotId(`bot-${id}`),
      name: input.name,
      slug,
      homePath,
      projectId,
      avatar: input.avatar ?? null,
      avatarColor: input.avatarColor ?? "sky",
      providerInstanceId: input.providerInstanceId ?? null,
      modelSelection: input.modelSelection ?? null,
      runtimeMode: input.runtimeMode ?? "auto-accept-edits",
      paused: false,
      firstRun: input.firstRun ?? input.soulContent === undefined,
      skillProjects: input.skillProjects ?? [],
      chatThreadId: null,
      tidyUpEnabled: input.tidyUpEnabled ?? true,
      tidyUpTimeOfDay: input.tidyUpTimeOfDay ?? "02:00",
      itemsStaleDays: input.itemsStaleDays ?? 5,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    yield* repo.upsertBot(bot);
    yield* syncTidyUpRoutine(bot);
    return bot;
  });

  const importFolder = Effect.fn("BotService.importFolder")(function* (
    input: BotsImportFolderInput,
  ) {
    const inferredName = input.name ?? path.basename(path.resolve(input.sourcePath));
    const existing = yield* repo.listBots();
    const usedSlugs = new Set<string>(existing.map((b) => b.slug));
    const slug = allocateUniqueSlug(input.slug ?? inferredName, usedSlugs);
    const homePath = path.join(botsRoot, slug);

    yield* withHomeServices(
      importBotFolder({
        sourcePath: input.sourcePath,
        targetHomePath: homePath,
        name: inferredName,
      }),
    );

    const projectId = yield* createBackingProject(inferredName, homePath);
    const timestamp = yield* nowIso();
    const id = yield* randomUuidV4;
    const bot: Bot = {
      id: decodeBotId(`bot-${id}`),
      name: inferredName,
      slug,
      homePath,
      projectId,
      avatar: input.avatar ?? null,
      avatarColor: input.avatarColor ?? "violet",
      providerInstanceId: input.providerInstanceId ?? null,
      modelSelection: input.modelSelection ?? null,
      runtimeMode: input.runtimeMode ?? "auto-accept-edits",
      paused: false,
      firstRun: false,
      skillProjects: [],
      chatThreadId: null,
      tidyUpEnabled: true,
      tidyUpTimeOfDay: "02:00",
      itemsStaleDays: 5,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    yield* repo.upsertBot(bot);
    yield* syncTidyUpRoutine(bot);
    return bot;
  });

  const update = Effect.fn("BotService.update")(function* (input: BotsUpdateInput) {
    const existing = yield* requireBot(input.botId);
    const timestamp = yield* nowIso();
    const updated: Bot = {
      ...existing,
      name: input.name ?? existing.name,
      avatar: input.avatar === undefined ? existing.avatar : input.avatar,
      avatarColor: input.avatarColor ?? existing.avatarColor,
      providerInstanceId:
        input.providerInstanceId === undefined
          ? existing.providerInstanceId
          : input.providerInstanceId,
      modelSelection:
        input.modelSelection === undefined ? existing.modelSelection : input.modelSelection,
      runtimeMode: input.runtimeMode ?? existing.runtimeMode,
      paused: input.paused ?? existing.paused,
      firstRun: input.firstRun ?? existing.firstRun,
      skillProjects: input.skillProjects ?? existing.skillProjects,
      tidyUpEnabled: input.tidyUpEnabled ?? existing.tidyUpEnabled,
      tidyUpTimeOfDay: input.tidyUpTimeOfDay ?? existing.tidyUpTimeOfDay,
      itemsStaleDays: input.itemsStaleDays ?? existing.itemsStaleDays,
      updatedAt: timestamp,
    };
    yield* repo.upsertBot(updated);
    if (
      updated.tidyUpEnabled !== existing.tidyUpEnabled ||
      updated.tidyUpTimeOfDay !== existing.tidyUpTimeOfDay ||
      updated.paused !== existing.paused
    ) {
      yield* syncTidyUpRoutine(updated);
    }
    if (updated.paused !== existing.paused) {
      const routines = yield* repo.listRoutinesByBot(updated.id);
      for (const routine of routines) {
        if (routine.isTidyUp) continue;
        const nextRunAt = yield* computeNextRunIso(
          routine.schedule,
          routine.enabled && !updated.paused,
        );
        yield* repo.upsertRoutine({
          ...routine,
          nextRunAt,
          updatedAt: timestamp,
        });
      }
    }
    return updated;
  });

  const deleteBot = Effect.fn("BotService.delete")(function* (input: BotsDeleteInput) {
    const existing = yield* repo.getBot(input.botId);
    if (Option.isNone(existing)) {
      return { botId: input.botId, deleted: false };
    }
    const deleted = yield* repo.deleteBot(input.botId);
    if (deleted && input.removeHomeDirectory) {
      yield* withHomeServices(removeBotHomeDirectory(existing.value.homePath));
    }
    return { botId: input.botId, deleted };
  });

  const launchBotThread = Effect.fn("BotService.launchBotThread")(function* (input: {
    readonly bot: Bot;
    readonly title: string;
    readonly prompt?: string | undefined;
    readonly callerLimits?:
      | {
          readonly runtimeMode: RuntimeMode;
          readonly interactionMode: ProviderInteractionMode;
        }
      | undefined;
  }) {
    const modelSelection = yield* resolveModelSelectionForBot(input.bot);
    const effectiveRuntimeMode =
      input.callerLimits === undefined
        ? input.bot.runtimeMode
        : runtimeModeRank(input.bot.runtimeMode) <= runtimeModeRank(input.callerLimits.runtimeMode)
          ? input.bot.runtimeMode
          : input.callerLimits.runtimeMode;
    const effectiveInteractionMode = input.callerLimits?.interactionMode ?? "default";
    const cmdUuid = yield* randomUuidV4;
    const msgUuid = yield* randomUuidV4;
    const result = yield* threadLaunch
      .launch({
        commandId: decodeCommandId(`cmd-${cmdUuid}`),
        projectId: input.bot.projectId,
        title: input.title,
        modelSelection,
        runtimeMode: effectiveRuntimeMode,
        interactionMode: effectiveInteractionMode,
        workspaceStrategy: { type: "root" },
        ...(input.prompt === undefined
          ? {}
          : {
              initialMessage: {
                messageId: decodeMessageId(`msg-${msgUuid}`),
                text: input.prompt,
                attachments: [],
              },
            }),
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new BotOperationError({
              message: `Failed to launch thread for bot "${input.bot.name}": ${error.message}`,
            }),
        ),
      );
    return result.threadId;
  });

  const openChat = Effect.fn("BotService.openChat")(function* (input: BotsOpenChatInput) {
    const bot = yield* requireBot(input.botId);
    const trimmedPrompt = input.initialPrompt?.trim();

    if (bot.chatThreadId !== null) {
      if (trimmedPrompt && trimmedPrompt.length > 0) {
        const cmdUuid = yield* randomUuidV4;
        const msgUuid = yield* randomUuidV4;
        yield* threadManagement
          .sendToThread({
            projectId: bot.projectId,
            commandId: decodeCommandId(`cmd-${cmdUuid}`),
            threadId: bot.chatThreadId,
            messageId: decodeMessageId(`msg-${msgUuid}`),
            text: trimmedPrompt,
            attachments: [],
            mode: "auto",
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new BotOperationError({
                  message: `Failed to send message to bot chat: ${error.message}`,
                }),
            ),
          );
      }
      return { bot, threadId: bot.chatThreadId, projectId: bot.projectId };
    }

    const promptToSend =
      trimmedPrompt && trimmedPrompt.length > 0
        ? trimmedPrompt
        : bot.firstRun
          ? buildFirstRunInterviewPrompt(bot.name)
          : undefined;

    const threadId = yield* launchBotThread({
      bot,
      title: `${bot.name}: Chat`,
      prompt: promptToSend,
    });

    const timestamp = yield* nowIso();
    const updated: Bot = {
      ...bot,
      chatThreadId: threadId,
      firstRun: false,
      updatedAt: timestamp,
    };
    yield* repo.upsertBot(updated);

    return { bot: updated, threadId, projectId: updated.projectId };
  });

  const handoff = Effect.fn("BotService.handoff")(function* (
    input: BotsHandoffInput,
    callerLimits?: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ) {
    const targetBot = yield* requireBot(input.targetBotId);
    if (targetBot.paused) {
      return yield* new BotOperationError({
        message: `Bot "${targetBot.name}" is paused and cannot accept handoffs.`,
      });
    }

    const fromBot =
      input.fromBotId === undefined ? Option.none() : yield* repo.getBot(input.fromBotId);
    const header = Option.isSome(fromBot)
      ? `[Handoff from @${fromBot.value.slug} (${fromBot.value.name})]`
      : "[Handoff]";
    const fullPrompt = `${header}\nTitle: ${input.title}\n\n${input.prompt}`;

    const canReusePrimary =
      input.usePrimaryChat &&
      targetBot.chatThreadId !== null &&
      (callerLimits === undefined ||
        (runtimeModeRank(targetBot.runtimeMode) <= runtimeModeRank(callerLimits.runtimeMode) &&
          callerLimits.interactionMode === "default"));

    let threadId: ThreadId;
    if (canReusePrimary) {
      const opened = yield* openChat({ botId: targetBot.id, initialPrompt: fullPrompt });
      threadId = opened.threadId;
    } else {
      threadId = yield* launchBotThread({
        bot: targetBot,
        title: input.title,
        prompt: fullPrompt,
        callerLimits,
      });
    }

    const timestamp = yield* nowIso();
    const itemUuid = yield* randomUuidV4;
    const item: BotItem = {
      id: decodeBotItemId(`bot-item-${itemUuid}`),
      botId: targetBot.id,
      title: input.title,
      summary: input.prompt.slice(0, 280),
      status: "in_progress",
      source: "handoff",
      threadId,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    };
    yield* repo.upsertItem(item);

    return {
      botId: targetBot.id,
      projectId: targetBot.projectId,
      threadId,
      item,
    };
  });

  const listFiles = Effect.fn("BotService.listFiles")(function* (input: BotsListFilesInput) {
    const bot = yield* requireBot(input.botId);
    const files = yield* withHomeServices(listBotHomeFiles(bot.homePath));
    return { botId: bot.id, files };
  });

  const readFile = Effect.fn("BotService.readFile")(function* (input: BotsReadFileInput) {
    const bot = yield* requireBot(input.botId);
    const result = yield* withHomeServices(readBotHomeFile(bot.homePath, input.relativePath));
    return { botId: bot.id, ...result };
  });

  const writeFile = Effect.fn("BotService.writeFile")(function* (input: BotsWriteFileInput) {
    const bot = yield* requireBot(input.botId);
    const result = yield* withHomeServices(
      writeBotHomeFile(bot.homePath, input.relativePath, input.content),
    );
    return { botId: bot.id, ...result };
  });

  const listRoutines = Effect.fn("BotService.listRoutines")(function* (
    input: BotsListRoutinesInput,
  ) {
    yield* requireBot(input.botId);
    const routines = yield* repo.listRoutinesByBot(input.botId);
    return { botId: input.botId, routines };
  });

  const upsertRoutine = Effect.fn("BotService.upsertRoutine")(function* (
    input: BotsUpsertRoutineInput,
  ) {
    const bot = yield* requireBot(input.botId);
    const existing =
      input.routineId === undefined ? Option.none() : yield* repo.getRoutine(input.routineId);
    const timestamp = yield* nowIso();
    const nextRunAt = yield* computeNextRunIso(input.schedule, input.enabled && !bot.paused);
    const precheckCommand =
      input.precheckCommand === undefined
        ? Option.isSome(existing)
          ? existing.value.precheckCommand
          : null
        : input.precheckCommand !== null && input.precheckCommand.trim().length > 0
          ? input.precheckCommand.trim()
          : null;

    const newId = yield* randomUuidV4;
    const routine: BotRoutine = Option.isSome(existing)
      ? {
          ...existing.value,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule: input.schedule,
          precheckCommand,
          nextRunAt,
          updatedAt: timestamp,
        }
      : {
          id: input.routineId ?? decodeBotRoutineId(`bot-routine-${newId}`),
          botId: bot.id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule: input.schedule,
          precheckCommand,
          lastPrecheckHash: null,
          isTidyUp: false,
          nextRunAt,
          lastRunAt: null,
          lastRunStatus: "idle",
          lastRunError: null,
          lastRunThreadId: null,
          runCount: decodeNonNegativeInt(0),
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    return yield* repo.upsertRoutine(routine);
  });

  const deleteRoutine = Effect.fn("BotService.deleteRoutine")(function* (
    input: BotsDeleteRoutineInput,
  ) {
    const deleted = yield* repo.deleteRoutine(input.routineId);
    return { routineId: input.routineId, deleted };
  });

  const runRoutineNow = Effect.fn("BotService.runRoutineNow")(function* (
    input: BotsRunRoutineNowInput,
  ) {
    const found = yield* repo.getRoutine(input.routineId);
    if (Option.isNone(found)) {
      return yield* new BotOperationError({
        message: `Routine "${input.routineId}" not found.`,
      });
    }
    const routine = found.value;
    const bot = yield* requireBot(routine.botId);
    const timestamp = yield* nowIso();
    const nextRunAt = yield* computeNextRunIso(routine.schedule, routine.enabled && !bot.paused);

    let nextPrecheckHash = routine.lastPrecheckHash;
    let precheckContext = "";

    if (
      routine.precheckCommand !== null &&
      routine.precheckCommand.trim().length > 0 &&
      !input.bypassPrecheck
    ) {
      const checkOutput = yield* processRunner
        .run({
          command: "sh",
          args: ["-c", routine.precheckCommand],
          cwd: bot.homePath,
          timeout: "30 seconds",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new BotOperationError({
                message: `Precheck failed to start: ${error.message}`,
              }),
          ),
        );

      const exitCode = checkOutput.code === null ? 1 : Number(checkOutput.code);
      const trimmedStdout = checkOutput.stdout.trim();
      const stdoutHash =
        trimmedStdout.length > 0 ? yield* withHomeServices(sha256Hex(trimmedStdout)) : null;

      if (
        checkOutput.timedOut ||
        exitCode !== 0 ||
        stdoutHash === null ||
        stdoutHash === routine.lastPrecheckHash
      ) {
        const skipped: BotRoutine = {
          ...routine,
          lastRunAt: timestamp,
          lastRunStatus: "skipped_precheck",
          lastRunError: checkOutput.timedOut
            ? "Precheck timed out"
            : exitCode !== 0
              ? `Precheck exited with code ${exitCode}`
              : null,
          nextRunAt,
          updatedAt: timestamp,
        };
        yield* repo.upsertRoutine(skipped);
        return { routine: skipped, status: "skipped_precheck" as const, threadId: null };
      }

      nextPrecheckHash = stdoutHash;
      precheckContext = `\n\nPrecheck output:\n\`\`\`\n${trimmedStdout.slice(0, 4000)}\n\`\`\``;
    }

    const launched = yield* launchBotThread({
      bot,
      title: `[Routine] ${routine.title}`,
      prompt: `${routine.prompt}${precheckContext}`,
    }).pipe(Effect.result);

    if (Result.isFailure(launched)) {
      const failed: BotRoutine = {
        ...routine,
        lastRunAt: timestamp,
        lastRunStatus: "failed",
        lastRunError: launched.failure.message,
        nextRunAt,
        updatedAt: timestamp,
      };
      yield* repo.upsertRoutine(failed);
      return { routine: failed, status: "failed" as const, threadId: null };
    }

    const threadId = launched.success;
    const succeeded: BotRoutine = {
      ...routine,
      lastPrecheckHash: nextPrecheckHash,
      lastRunAt: timestamp,
      lastRunStatus: "succeeded",
      lastRunError: null,
      lastRunThreadId: threadId,
      runCount: decodeNonNegativeInt(routine.runCount + 1),
      nextRunAt,
      updatedAt: timestamp,
    };
    yield* repo.upsertRoutine(succeeded);

    if (!routine.isTidyUp) {
      const itemUuid = yield* randomUuidV4;
      const item: BotItem = {
        id: decodeBotItemId(`bot-item-${itemUuid}`),
        botId: bot.id,
        title: routine.title,
        summary: routine.prompt.slice(0, 280),
        status: "in_progress",
        source: "routine",
        threadId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastActivityAt: timestamp,
      };
      yield* repo.upsertItem(item);
    }

    return { routine: succeeded, status: "succeeded" as const, threadId };
  });

  const runDueRoutines = Effect.fn("BotService.runDueRoutines")(function* () {
    const timestamp = yield* nowIso();
    const due = yield* repo.listDueRoutines(timestamp);
    let processed = 0;
    for (const routine of due) {
      yield* runRoutineNow({ routineId: routine.id }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Bot routine execution failed").pipe(
            Effect.annotateLogs({ routineId: routine.id, error: error.message }),
          ),
        ),
      );
      processed += 1;
    }
    return processed;
  });

  const listGroups = Effect.fn("BotService.listGroups")(function* () {
    const groups = yield* repo.listGroups();
    return { groups };
  });

  const createGroup = Effect.fn("BotService.createGroup")(function* (input: BotsCreateGroupInput) {
    const uniqueMembers = [...new Set(input.memberBotIds)];
    for (const botId of uniqueMembers) {
      yield* requireBot(botId);
    }
    const timestamp = yield* nowIso();
    const id = yield* randomUuidV4;
    const group: BotGroup = {
      id: decodeBotGroupId(`bot-group-${id}`),
      name: input.name,
      memberBotIds: uniqueMembers,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return yield* repo.upsertGroup(group);
  });

  const updateGroup = Effect.fn("BotService.updateGroup")(function* (input: BotsUpdateGroupInput) {
    const existing = yield* repo.getGroup(input.groupId);
    if (Option.isNone(existing)) {
      return yield* new BotOperationError({ message: `Group "${input.groupId}" not found.` });
    }
    const memberBotIds =
      input.memberBotIds === undefined
        ? existing.value.memberBotIds
        : [...new Set(input.memberBotIds)];
    for (const botId of memberBotIds) {
      yield* requireBot(botId);
    }
    const timestamp = yield* nowIso();
    const updated: BotGroup = {
      ...existing.value,
      name: input.name ?? existing.value.name,
      memberBotIds,
      updatedAt: timestamp,
    };
    return yield* repo.upsertGroup(updated);
  });

  const deleteGroup = Effect.fn("BotService.deleteGroup")(function* (input: BotsDeleteGroupInput) {
    const deleted = yield* repo.deleteGroup(input.groupId);
    return { groupId: input.groupId, deleted };
  });

  const listGroupMessages = Effect.fn("BotService.listGroupMessages")(function* (
    input: BotsListGroupMessagesInput,
  ) {
    const group = yield* repo.getGroup(input.groupId);
    if (Option.isNone(group)) {
      return yield* new BotOperationError({ message: `Group "${input.groupId}" not found.` });
    }
    const messages = yield* repo.listGroupMessages(input.groupId, input.limit ?? 100);
    return { groupId: input.groupId, messages };
  });

  const sendGroupMessage = Effect.fn("BotService.sendGroupMessage")(function* (
    input: BotsSendGroupMessageInput,
    callerLimits?: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ) {
    const groupOption = yield* repo.getGroup(input.groupId);
    if (Option.isNone(groupOption)) {
      return yield* new BotOperationError({ message: `Group "${input.groupId}" not found.` });
    }
    const group = groupOption.value;

    const allBots = yield* repo.listBots();
    const botById = new Map<BotId, Bot>(allBots.map((b) => [b.id, b]));
    const memberBots = group.memberBotIds
      .map((id) => botById.get(id))
      .filter((b): b is Bot => b !== undefined);

    const senderBot = input.senderBotId === undefined ? undefined : botById.get(input.senderBotId);
    const mentionedBotIds = parseGroupMentions(input.body, memberBots);

    const timestamp = yield* nowIso();
    const msgUuid = yield* randomUuidV4;
    const message: BotGroupMessage = {
      id: decodeBotGroupMessageId(`bot-gmsg-${msgUuid}`),
      groupId: group.id,
      senderType: senderBot ? "bot" : "user",
      senderBotId: senderBot ? senderBot.id : null,
      senderName: senderBot ? senderBot.name : "You",
      body: input.body,
      mentionedBotIds: [...mentionedBotIds],
      threadId: null,
      createdAt: timestamp,
    };
    yield* repo.insertGroupMessage(message);

    const targets =
      mentionedBotIds.length > 0
        ? memberBots.filter(
            (b) => mentionedBotIds.includes(b.id) && b.id !== input.senderBotId && !b.paused,
          )
        : senderBot === undefined
          ? memberBots.filter((b) => !b.paused)
          : [];

    const recentMessages = yield* repo.listGroupMessages(group.id, 12);
    const transcript = recentMessages.map((m) => `${m.senderName}: ${m.body}`).join("\n");

    const dispatchedBotIds: Array<BotId> = [];
    const threadIds: Array<ThreadId> = [];

    for (const target of targets) {
      const prompt = [
        `[Group Chat: ${group.name}]`,
        `Members: ${memberBots.map((b) => `@${b.slug} (${b.name})`).join(", ")}`,
        "",
        "Recent messages:",
        transcript,
        "",
        `You (@${target.slug}) were addressed in this group. Handle your part of the request.`,
        `When you have a reply for the group, call \`bot_group_send\` with groupId "${group.id}" and senderBotId "${target.id}".`,
      ].join("\n");

      const launched = yield* launchBotThread({
        bot: target,
        title: `[Group: ${group.name}] ${input.body.slice(0, 60)}`,
        prompt,
        callerLimits,
      }).pipe(Effect.result);

      if (Result.isSuccess(launched)) {
        dispatchedBotIds.push(target.id);
        threadIds.push(launched.success);
        const itemUuid = yield* randomUuidV4;
        const item: BotItem = {
          id: decodeBotItemId(`bot-item-${itemUuid}`),
          botId: target.id,
          title: `${group.name}: ${input.body.slice(0, 80)}`,
          summary: input.body.slice(0, 280),
          status: "in_progress",
          source: "group",
          threadId: launched.success,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastActivityAt: timestamp,
        };
        yield* repo.upsertItem(item);
      }
    }

    return { message, dispatchedBotIds, threadIds };
  });

  const listItems = Effect.fn("BotService.listItems")(function* (input: BotsListItemsInput) {
    yield* requireBot(input.botId);
    const items = yield* repo.listItemsByBot(input.botId, input.status);
    return { botId: input.botId, items };
  });

  const createItem = Effect.fn("BotService.createItem")(function* (input: BotsCreateItemInput) {
    yield* requireBot(input.botId);
    const timestamp = yield* nowIso();
    const id = yield* randomUuidV4;
    const item: BotItem = {
      id: decodeBotItemId(`bot-item-${id}`),
      botId: input.botId,
      title: input.title,
      summary: input.summary ?? "",
      status: input.status ?? "open",
      source: input.source ?? "manual",
      threadId: input.threadId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    };
    return yield* repo.upsertItem(item);
  });

  const updateItem = Effect.fn("BotService.updateItem")(function* (input: BotsUpdateItemInput) {
    const existing = yield* repo.getItem(input.itemId);
    if (Option.isNone(existing)) {
      return yield* new BotOperationError({ message: `Bot item "${input.itemId}" not found.` });
    }
    const timestamp = yield* nowIso();
    const updated: BotItem = {
      ...existing.value,
      title: input.title ?? existing.value.title,
      summary: input.summary ?? existing.value.summary,
      status: input.status ?? existing.value.status,
      threadId: input.threadId === undefined ? existing.value.threadId : input.threadId,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    };
    return yield* repo.upsertItem(updated);
  });

  const deleteItem = Effect.fn("BotService.deleteItem")(function* (input: BotsDeleteItemInput) {
    const deleted = yield* repo.deleteItem(input.itemId);
    return { itemId: input.itemId, deleted };
  });

  const sweepStaleItems = Effect.fn("BotService.sweepStaleItems")(function* () {
    const bots = yield* repo.listBots();
    const nowMillis = yield* Clock.currentTimeMillis;
    const nowTimestamp = decodeIsoDateTime(DateTime.formatIso(DateTime.makeUnsafe(nowMillis)));
    let totalMarked = 0;

    for (const bot of bots) {
      if (bot.itemsStaleDays === "never") continue;
      const cutoffIso = decodeIsoDateTime(
        DateTime.formatIso(DateTime.makeUnsafe(nowMillis - bot.itemsStaleDays * DAY_MS)),
      );
      totalMarked += yield* repo.markStaleItemsForBot(bot.id, cutoffIso, nowTimestamp);
    }

    return totalMarked;
  });

  return BotService.of({
    list,
    get,
    create,
    update,
    delete: deleteBot,
    importFolder,
    openChat,
    handoff,
    listFiles,
    readFile,
    writeFile,
    listRoutines,
    upsertRoutine,
    deleteRoutine,
    runRoutineNow,
    runDueRoutines,
    listGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    listGroupMessages,
    sendGroupMessage,
    listItems,
    createItem,
    updateItem,
    deleteItem,
    sweepStaleItems,
  });
});

export const layer = Layer.effect(BotService, make);
