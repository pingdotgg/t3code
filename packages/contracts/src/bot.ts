import * as Schema from "effect/Schema";

import {
  BotGroupId,
  BotGroupMessageId,
  BotId,
  BotItemId,
  BotRoutineId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ScheduledTaskSchedule } from "./scheduledTask.ts";

export const BotAvatarColor = Schema.Literals([
  "sky",
  "emerald",
  "amber",
  "rose",
  "violet",
  "slate",
  "indigo",
  "teal",
]);
export type BotAvatarColor = typeof BotAvatarColor.Type;

export const BotItemsStaleDays = Schema.Literals([3, 5, 7, 14, "never"]);
export type BotItemsStaleDays = typeof BotItemsStaleDays.Type;

export const BotSlug = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
export type BotSlug = typeof BotSlug.Type;

export const BotTimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]?\d|2[0-3]):([0-5]\d)$/),
);
export type BotTimeOfDay = typeof BotTimeOfDay.Type;

export const Bot = Schema.Struct({
  id: BotId,
  name: TrimmedNonEmptyString,
  slug: BotSlug,
  homePath: TrimmedNonEmptyString,
  projectId: ProjectId,
  avatar: Schema.NullOr(Schema.String),
  avatarColor: BotAvatarColor,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  modelSelection: Schema.NullOr(ModelSelection),
  runtimeMode: RuntimeMode,
  paused: Schema.Boolean,
  firstRun: Schema.Boolean,
  skillProjects: Schema.Array(ProjectId),
  chatThreadId: Schema.NullOr(ThreadId),
  tidyUpEnabled: Schema.Boolean,
  tidyUpTimeOfDay: BotTimeOfDay,
  itemsStaleDays: BotItemsStaleDays,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Bot = typeof Bot.Type;

export const BotFileKind = Schema.Literals(["soul", "memory", "skill", "config", "other"]);
export type BotFileKind = typeof BotFileKind.Type;

export const BotFileEntry = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  kind: BotFileKind,
  sizeBytes: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type BotFileEntry = typeof BotFileEntry.Type;

export const BotRoutineRunStatus = Schema.Literals([
  "idle",
  "running",
  "succeeded",
  "skipped_precheck",
  "failed",
]);
export type BotRoutineRunStatus = typeof BotRoutineRunStatus.Type;

export const BotRoutine = Schema.Struct({
  id: BotRoutineId,
  botId: BotId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  precheckCommand: Schema.NullOr(Schema.String),
  lastPrecheckHash: Schema.NullOr(Schema.String),
  isTidyUp: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: BotRoutineRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  lastRunThreadId: Schema.NullOr(ThreadId),
  runCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotRoutine = typeof BotRoutine.Type;

export const BotGroup = Schema.Struct({
  id: BotGroupId,
  name: TrimmedNonEmptyString,
  memberBotIds: Schema.Array(BotId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotGroup = typeof BotGroup.Type;

export const BotGroupSenderType = Schema.Literals(["user", "bot"]);
export type BotGroupSenderType = typeof BotGroupSenderType.Type;

export const BotGroupMessage = Schema.Struct({
  id: BotGroupMessageId,
  groupId: BotGroupId,
  senderType: BotGroupSenderType,
  senderBotId: Schema.NullOr(BotId),
  senderName: TrimmedNonEmptyString,
  body: Schema.String,
  mentionedBotIds: Schema.Array(BotId),
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
});
export type BotGroupMessage = typeof BotGroupMessage.Type;

export const BotItemStatus = Schema.Literals(["open", "in_progress", "done", "stale", "dismissed"]);
export type BotItemStatus = typeof BotItemStatus.Type;

export const BotItemSource = Schema.Literals(["chat", "routine", "handoff", "group", "manual"]);
export type BotItemSource = typeof BotItemSource.Type;

export const BotItem = Schema.Struct({
  id: BotItemId,
  botId: BotId,
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  status: BotItemStatus,
  source: BotItemSource,
  threadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
});
export type BotItem = typeof BotItem.Type;

export const BotsListResult = Schema.Struct({
  bots: Schema.Array(Bot),
});
export type BotsListResult = typeof BotsListResult.Type;

export const BotsGetInput = Schema.Struct({
  botId: BotId,
});
export type BotsGetInput = typeof BotsGetInput.Type;

export const BotsCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  slug: Schema.optional(BotSlug),
  avatar: Schema.optional(Schema.NullOr(Schema.String)),
  avatarColor: Schema.optional(BotAvatarColor),
  providerInstanceId: Schema.optional(Schema.NullOr(ProviderInstanceId)),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(RuntimeMode),
  soulContent: Schema.optional(Schema.String),
  skillProjects: Schema.optional(Schema.Array(ProjectId)),
  tidyUpEnabled: Schema.optional(Schema.Boolean),
  tidyUpTimeOfDay: Schema.optional(BotTimeOfDay),
  itemsStaleDays: Schema.optional(BotItemsStaleDays),
  firstRun: Schema.optional(Schema.Boolean),
});
export type BotsCreateInput = typeof BotsCreateInput.Type;

export const BotsUpdateInput = Schema.Struct({
  botId: BotId,
  name: Schema.optional(TrimmedNonEmptyString),
  avatar: Schema.optional(Schema.NullOr(Schema.String)),
  avatarColor: Schema.optional(BotAvatarColor),
  providerInstanceId: Schema.optional(Schema.NullOr(ProviderInstanceId)),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(RuntimeMode),
  paused: Schema.optional(Schema.Boolean),
  firstRun: Schema.optional(Schema.Boolean),
  skillProjects: Schema.optional(Schema.Array(ProjectId)),
  tidyUpEnabled: Schema.optional(Schema.Boolean),
  tidyUpTimeOfDay: Schema.optional(BotTimeOfDay),
  itemsStaleDays: Schema.optional(BotItemsStaleDays),
});
export type BotsUpdateInput = typeof BotsUpdateInput.Type;

export const BotsDeleteInput = Schema.Struct({
  botId: BotId,
  removeHomeDirectory: Schema.optional(Schema.Boolean),
});
export type BotsDeleteInput = typeof BotsDeleteInput.Type;

export const BotsDeleteResult = Schema.Struct({
  botId: BotId,
  deleted: Schema.Boolean,
});
export type BotsDeleteResult = typeof BotsDeleteResult.Type;

export const BotsImportFolderInput = Schema.Struct({
  sourcePath: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  slug: Schema.optional(BotSlug),
  avatar: Schema.optional(Schema.NullOr(Schema.String)),
  avatarColor: Schema.optional(BotAvatarColor),
  providerInstanceId: Schema.optional(Schema.NullOr(ProviderInstanceId)),
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(RuntimeMode),
});
export type BotsImportFolderInput = typeof BotsImportFolderInput.Type;

export const BotsOpenChatInput = Schema.Struct({
  botId: BotId,
  initialPrompt: Schema.optional(Schema.String),
});
export type BotsOpenChatInput = typeof BotsOpenChatInput.Type;

export const BotsOpenChatResult = Schema.Struct({
  bot: Bot,
  threadId: ThreadId,
  projectId: ProjectId,
});
export type BotsOpenChatResult = typeof BotsOpenChatResult.Type;

export const BotsHandoffInput = Schema.Struct({
  targetBotId: BotId,
  fromBotId: Schema.optional(BotId),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  usePrimaryChat: Schema.optional(Schema.Boolean),
});
export type BotsHandoffInput = typeof BotsHandoffInput.Type;

export const BotsHandoffResult = Schema.Struct({
  botId: BotId,
  projectId: ProjectId,
  threadId: ThreadId,
  item: BotItem,
});
export type BotsHandoffResult = typeof BotsHandoffResult.Type;

export const BotsListFilesInput = Schema.Struct({
  botId: BotId,
});
export type BotsListFilesInput = typeof BotsListFilesInput.Type;

export const BotsListFilesResult = Schema.Struct({
  botId: BotId,
  files: Schema.Array(BotFileEntry),
});
export type BotsListFilesResult = typeof BotsListFilesResult.Type;

export const BotsReadFileInput = Schema.Struct({
  botId: BotId,
  relativePath: TrimmedNonEmptyString,
});
export type BotsReadFileInput = typeof BotsReadFileInput.Type;

export const BotsReadFileResult = Schema.Struct({
  botId: BotId,
  relativePath: TrimmedNonEmptyString,
  content: Schema.String,
});
export type BotsReadFileResult = typeof BotsReadFileResult.Type;

export const BotsWriteFileInput = Schema.Struct({
  botId: BotId,
  relativePath: TrimmedNonEmptyString,
  content: Schema.String,
});
export type BotsWriteFileInput = typeof BotsWriteFileInput.Type;

export const BotsWriteFileResult = Schema.Struct({
  botId: BotId,
  relativePath: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type BotsWriteFileResult = typeof BotsWriteFileResult.Type;

export const BotsListRoutinesInput = Schema.Struct({
  botId: BotId,
});
export type BotsListRoutinesInput = typeof BotsListRoutinesInput.Type;

export const BotsListRoutinesResult = Schema.Struct({
  botId: BotId,
  routines: Schema.Array(BotRoutine),
});
export type BotsListRoutinesResult = typeof BotsListRoutinesResult.Type;

export const BotsUpsertRoutineInput = Schema.Struct({
  routineId: Schema.optional(BotRoutineId),
  botId: BotId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  precheckCommand: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BotsUpsertRoutineInput = typeof BotsUpsertRoutineInput.Type;

export const BotsDeleteRoutineInput = Schema.Struct({
  routineId: BotRoutineId,
});
export type BotsDeleteRoutineInput = typeof BotsDeleteRoutineInput.Type;

export const BotsDeleteRoutineResult = Schema.Struct({
  routineId: BotRoutineId,
  deleted: Schema.Boolean,
});
export type BotsDeleteRoutineResult = typeof BotsDeleteRoutineResult.Type;

export const BotsRunRoutineNowInput = Schema.Struct({
  routineId: BotRoutineId,
  bypassPrecheck: Schema.optional(Schema.Boolean),
});
export type BotsRunRoutineNowInput = typeof BotsRunRoutineNowInput.Type;

export const BotsRunRoutineNowResult = Schema.Struct({
  routine: BotRoutine,
  status: BotRoutineRunStatus,
  threadId: Schema.NullOr(ThreadId),
});
export type BotsRunRoutineNowResult = typeof BotsRunRoutineNowResult.Type;

export const BotsListGroupsResult = Schema.Struct({
  groups: Schema.Array(BotGroup),
});
export type BotsListGroupsResult = typeof BotsListGroupsResult.Type;

export const BotsCreateGroupInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  memberBotIds: Schema.Array(BotId),
});
export type BotsCreateGroupInput = typeof BotsCreateGroupInput.Type;

export const BotsUpdateGroupInput = Schema.Struct({
  groupId: BotGroupId,
  name: Schema.optional(TrimmedNonEmptyString),
  memberBotIds: Schema.optional(Schema.Array(BotId)),
});
export type BotsUpdateGroupInput = typeof BotsUpdateGroupInput.Type;

export const BotsDeleteGroupInput = Schema.Struct({
  groupId: BotGroupId,
});
export type BotsDeleteGroupInput = typeof BotsDeleteGroupInput.Type;

export const BotsDeleteGroupResult = Schema.Struct({
  groupId: BotGroupId,
  deleted: Schema.Boolean,
});
export type BotsDeleteGroupResult = typeof BotsDeleteGroupResult.Type;

export const BotsListGroupMessagesInput = Schema.Struct({
  groupId: BotGroupId,
  limit: Schema.optional(NonNegativeInt),
});
export type BotsListGroupMessagesInput = typeof BotsListGroupMessagesInput.Type;

export const BotsListGroupMessagesResult = Schema.Struct({
  groupId: BotGroupId,
  messages: Schema.Array(BotGroupMessage),
});
export type BotsListGroupMessagesResult = typeof BotsListGroupMessagesResult.Type;

export const BotsSendGroupMessageInput = Schema.Struct({
  groupId: BotGroupId,
  body: TrimmedNonEmptyString,
  senderBotId: Schema.optional(BotId),
});
export type BotsSendGroupMessageInput = typeof BotsSendGroupMessageInput.Type;

export const BotsSendGroupMessageResult = Schema.Struct({
  message: BotGroupMessage,
  dispatchedBotIds: Schema.Array(BotId),
  threadIds: Schema.Array(ThreadId),
});
export type BotsSendGroupMessageResult = typeof BotsSendGroupMessageResult.Type;

export const BotsListItemsInput = Schema.Struct({
  botId: BotId,
  status: Schema.optional(BotItemStatus),
});
export type BotsListItemsInput = typeof BotsListItemsInput.Type;

export const BotsListItemsResult = Schema.Struct({
  botId: BotId,
  items: Schema.Array(BotItem),
});
export type BotsListItemsResult = typeof BotsListItemsResult.Type;

export const BotsCreateItemInput = Schema.Struct({
  botId: BotId,
  title: TrimmedNonEmptyString,
  summary: Schema.optional(Schema.String),
  status: Schema.optional(BotItemStatus),
  source: Schema.optional(BotItemSource),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type BotsCreateItemInput = typeof BotsCreateItemInput.Type;

export const BotsUpdateItemInput = Schema.Struct({
  itemId: BotItemId,
  title: Schema.optional(TrimmedNonEmptyString),
  summary: Schema.optional(Schema.String),
  status: Schema.optional(BotItemStatus),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type BotsUpdateItemInput = typeof BotsUpdateItemInput.Type;

export const BotsDeleteItemInput = Schema.Struct({
  itemId: BotItemId,
});
export type BotsDeleteItemInput = typeof BotsDeleteItemInput.Type;

export const BotsDeleteItemResult = Schema.Struct({
  itemId: BotItemId,
  deleted: Schema.Boolean,
});
export type BotsDeleteItemResult = typeof BotsDeleteItemResult.Type;

export class BotOperationError extends Schema.TaggedError<BotOperationError>()(
  "BotOperationError",
  {
    message: Schema.String,
  },
) {}
