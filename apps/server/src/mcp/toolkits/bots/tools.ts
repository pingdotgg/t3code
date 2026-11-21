import {
  Bot,
  BotGroup,
  BotGroupId,
  BotGroupMessage,
  BotId,
  BotItem,
  BotItemId,
  BotItemStatus,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
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
  description: "List all configured bots on this environment.",
  success: Schema.Struct({
    bots: Schema.Array(Bot),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotGetTool = Tool.make("bot_get", {
  ...shared,
  description: "Get one bot's configuration and home directory details.",
  parameters: Schema.Struct({
    botId: BotId,
  }),
  success: Bot,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotHandoffTool = Tool.make("bot_handoff", {
  ...shared,
  description:
    "Hand off a task to another bot. Launches a thread in the target bot's workspace and records an open work item.",
  parameters: Schema.Struct({
    targetBotId: BotId,
    fromBotId: Schema.optionalKey(BotId),
    title: TrimmedNonEmptyString,
    prompt: TrimmedNonEmptyString,
    usePrimaryChat: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    botId: BotId,
    projectId: ProjectId,
    threadId: ThreadId,
    item: BotItem,
  }),
}).annotate(Tool.Destructive, false);

const BotItemCreateTool = Tool.make("bot_item_create", {
  ...shared,
  description: "Create a tracked work item in a bot's work queue.",
  parameters: Schema.Struct({
    botId: BotId,
    title: TrimmedNonEmptyString,
    summary: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(BotItemStatus),
  }),
  success: BotItem,
}).annotate(Tool.Destructive, false);

const BotItemUpdateTool = Tool.make("bot_item_update", {
  ...shared,
  description: "Update the status or summary of a tracked bot work item.",
  parameters: Schema.Struct({
    itemId: BotItemId,
    title: Schema.optionalKey(TrimmedNonEmptyString),
    summary: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(BotItemStatus),
  }),
  success: BotItem,
}).annotate(Tool.Destructive, false);

const BotGroupListTool = Tool.make("bot_group_list", {
  ...shared,
  description: "List all multi-bot group chats.",
  success: Schema.Struct({
    groups: Schema.Array(BotGroup),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BotGroupSendTool = Tool.make("bot_group_send", {
  ...shared,
  description: "Post a message to a multi-bot group chat. Mentioning @slug dispatches to that bot.",
  parameters: Schema.Struct({
    groupId: BotGroupId,
    body: TrimmedNonEmptyString,
    senderBotId: Schema.optionalKey(BotId),
  }),
  success: Schema.Struct({
    message: BotGroupMessage,
    dispatchedBotIds: Schema.Array(BotId),
    threadIds: Schema.Array(ThreadId),
  }),
}).annotate(Tool.Destructive, false);

export const BotsToolkit = Toolkit.make(
  BotListTool,
  BotGetTool,
  BotHandoffTool,
  BotItemCreateTool,
  BotItemUpdateTool,
  BotGroupListTool,
  BotGroupSendTool,
);
