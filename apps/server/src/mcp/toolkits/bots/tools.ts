import {
  Bot,
  BotGroup,
  BotItem,
  BotRoutine,
  BotsCreateGroupInput,
  BotsCreateInput,
  BotsCreateItemInput,
  BotsDeleteGroupInput,
  BotsDeleteGroupResult,
  BotsDeleteInput,
  BotsDeleteItemInput,
  BotsDeleteItemResult,
  BotsDeleteResult,
  BotsDeleteRoutineInput,
  BotsDeleteRoutineResult,
  BotsGetInput,
  BotsHandoffInput,
  BotsHandoffResult,
  BotsImportFolderInput,
  BotsListFilesInput,
  BotsListFilesResult,
  BotsListGroupMessagesInput,
  BotsListGroupMessagesResult,
  BotsListGroupsResult,
  BotsListItemsInput,
  BotsListItemsResult,
  BotsListResult,
  BotsListRoutinesInput,
  BotsListRoutinesResult,
  BotsReadFileInput,
  BotsReadFileResult,
  BotsRunRoutineNowInput,
  BotsRunRoutineNowResult,
  BotsSendGroupMessageInput,
  BotsSendGroupMessageResult,
  BotsUpdateGroupInput,
  BotsUpdateInput,
  BotsUpdateItemInput,
  BotsUpsertRoutineInput,
  BotsWriteFileInput,
  BotsWriteFileResult,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BotService.BotService,
  ],
};

const BotListTool = Tool.make("bot_list", {
  ...shared,
  description: "List all configured bots on an environment.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: BotsListResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotGetTool = Tool.make("bot_get", {
  ...shared,
  description: "Get one bot's configuration and home directory details.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsGetInput.fields,
  }),
  success: Bot,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotCreateTool = Tool.make("bot_create", {
  ...shared,
  description:
    "Create a bot, initialize its home directory (SOUL.md, MEMORY.md, AGENTS.md, CLAUDE.md, memory/, skills/), create its backing project, and configure its nightly memory tidy-up routine.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsCreateInput.fields,
  }),
  success: Bot,
}).annotate(Tool.Destructive, false);

const BotUpdateTool = Tool.make("bot_update", {
  ...shared,
  description:
    "Update a bot's settings (name, avatar, provider/model, runtime mode, paused state, tidy-up schedule, stale days, skill projects). Omitted fields stay unchanged; changing pause or tidy-up recalculates routine nextRunAt.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsUpdateInput.fields,
  }),
  success: Bot,
}).annotate(Tool.Destructive, true);

const BotDeleteTool = Tool.make("bot_delete", {
  ...shared,
  description:
    "Delete a bot and its backing project. Pass removeHomeDirectory: true to also remove its home directory on disk.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsDeleteInput.fields,
  }),
  success: BotsDeleteResult,
}).annotate(Tool.Destructive, true);

const BotImportFolderTool = Tool.make("bot_import_folder", {
  ...shared,
  description:
    "Import an existing folder into a new bot home (copying SOUL.md, skills/, README.md, examples/) and register the bot.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsImportFolderInput.fields,
  }),
  success: Bot,
}).annotate(Tool.Destructive, false);

const BotFileListTool = Tool.make("bot_file_list", {
  ...shared,
  description: "List files inside a bot's home directory.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsListFilesInput.fields,
  }),
  success: BotsListFilesResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotFileReadTool = Tool.make("bot_file_read", {
  ...shared,
  description: "Read a file inside a bot's home directory (e.g. SOUL.md, MEMORY.md, skills/...).",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsReadFileInput.fields,
  }),
  success: BotsReadFileResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotFileWriteTool = Tool.make("bot_file_write", {
  ...shared,
  description:
    "Create or overwrite a file inside a bot's home directory (creates parent directories as needed).",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsWriteFileInput.fields,
  }),
  success: BotsWriteFileResult,
}).annotate(Tool.Destructive, true);

const BotRoutineListTool = Tool.make("bot_routine_list", {
  ...shared,
  description: "List a bot's scheduled routines (including nightly memory tidy-up) and run state.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsListRoutinesInput.fields,
  }),
  success: BotsListRoutinesResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotRoutineUpsertTool = Tool.make("bot_routine_upsert", {
  ...shared,
  description:
    "Create a scheduled routine for a bot, or update an existing routine when routineId is provided. Automatically computes nextRunAt in the server's local timezone.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsUpsertRoutineInput.fields,
  }),
  success: BotRoutine,
}).annotate(Tool.Destructive, true);

const BotRoutineDeleteTool = Tool.make("bot_routine_delete", {
  ...shared,
  description: "Delete a bot routine.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsDeleteRoutineInput.fields,
  }),
  success: BotsDeleteRoutineResult,
}).annotate(Tool.Destructive, true);

const BotRoutineRunTool = Tool.make("bot_routine_run", {
  ...shared,
  description: "Trigger a bot routine immediately (optionally bypassing its precheck command).",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsRunRoutineNowInput.fields,
  }),
  success: BotsRunRoutineNowResult,
}).annotate(Tool.Destructive, false);

const BotHandoffTool = Tool.make("bot_handoff", {
  ...shared,
  description:
    "Hand off a task to another bot. Launches a thread in the target bot's workspace and records an open work item.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsHandoffInput.fields,
  }),
  success: BotsHandoffResult,
}).annotate(Tool.Destructive, false);

const BotItemListTool = Tool.make("bot_item_list", {
  ...shared,
  description: "List tracked work items in a bot's work queue, optionally filtered by status.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsListItemsInput.fields,
  }),
  success: BotsListItemsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotItemCreateTool = Tool.make("bot_item_create", {
  ...shared,
  description: "Create a tracked work item in a bot's work queue.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsCreateItemInput.fields,
  }),
  success: BotItem,
}).annotate(Tool.Destructive, false);

const BotItemUpdateTool = Tool.make("bot_item_update", {
  ...shared,
  description: "Update the status or summary of a tracked bot work item.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsUpdateItemInput.fields,
  }),
  success: BotItem,
}).annotate(Tool.Destructive, false);

const BotItemDeleteTool = Tool.make("bot_item_delete", {
  ...shared,
  description: "Delete a tracked work item from a bot's work queue.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsDeleteItemInput.fields,
  }),
  success: BotsDeleteItemResult,
}).annotate(Tool.Destructive, true);

const BotGroupListTool = Tool.make("bot_group_list", {
  ...shared,
  description: "List all multi-bot group chats.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
  }),
  success: BotsListGroupsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotGroupCreateTool = Tool.make("bot_group_create", {
  ...shared,
  description: "Create a multi-bot group chat.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsCreateGroupInput.fields,
  }),
  success: BotGroup,
}).annotate(Tool.Destructive, false);

const BotGroupUpdateTool = Tool.make("bot_group_update", {
  ...shared,
  description: "Update a multi-bot group chat's name or member bots.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsUpdateGroupInput.fields,
  }),
  success: BotGroup,
}).annotate(Tool.Destructive, true);

const BotGroupDeleteTool = Tool.make("bot_group_delete", {
  ...shared,
  description: "Delete a multi-bot group chat and its message history.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsDeleteGroupInput.fields,
  }),
  success: BotsDeleteGroupResult,
}).annotate(Tool.Destructive, true);

const BotGroupMessagesTool = Tool.make("bot_group_messages", {
  ...shared,
  description: "List messages in a multi-bot group chat.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsListGroupMessagesInput.fields,
  }),
  success: BotsListGroupMessagesResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotGroupSendTool = Tool.make("bot_group_send", {
  ...shared,
  description: "Post a message to a multi-bot group chat. Mentioning @slug dispatches to that bot.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    ...BotsSendGroupMessageInput.fields,
  }),
  success: BotsSendGroupMessageResult,
}).annotate(Tool.Destructive, false);

export const BotsToolkit = Toolkit.make(
  BotListTool,
  BotGetTool,
  BotCreateTool,
  BotUpdateTool,
  BotDeleteTool,
  BotImportFolderTool,
  BotFileListTool,
  BotFileReadTool,
  BotFileWriteTool,
  BotRoutineListTool,
  BotRoutineUpsertTool,
  BotRoutineDeleteTool,
  BotRoutineRunTool,
  BotHandoffTool,
  BotItemListTool,
  BotItemCreateTool,
  BotItemUpdateTool,
  BotItemDeleteTool,
  BotGroupListTool,
  BotGroupCreateTool,
  BotGroupUpdateTool,
  BotGroupDeleteTool,
  BotGroupMessagesTool,
  BotGroupSendTool,
);
