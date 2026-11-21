import {
  BOT_FILE_MAX_CHARS,
  BotWatch,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Listed only to Bot threads (Home among them); tool search never offers them to others. */
export const BOT_TOOL_PREFIX = "t3_bot_";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BotService.BotService,
  ],
};
const Saved = Schema.Struct({ saved: Schema.Boolean });
const Watches = Schema.Struct({ watches: Schema.Array(BotWatch) });
const WatchTargetInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  workflowRunId: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Instead of `threadId`." }),
  ),
});

const MemoryRead = Tool.make("t3_bot_memory_read", {
  ...shared,
  description:
    "Read your memory: notes.md (your working notes), preferences.md (what the user wants you to keep doing), and the threads and workflow runs you watch beyond your crew.",
  // No `parameters`: an explicit Schema.Struct({}) advertises `anyOf: [object, array]`,
  // which MCP clients reject. The default EmptyParams advertises `type: "object"`.
  success: Schema.Struct({
    notes: Schema.String,
    preferences: Schema.String,
    watches: Schema.Array(BotWatch),
  }),
})
  .annotate(Tool.Title, "Read Bot memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const NotesWrite = Tool.make("t3_bot_notes_write", {
  ...shared,
  description:
    "Replace your notes.md: ongoing efforts, which crew thread owns what, decisions. Keep it short and current; the user can read it.",
  parameters: Schema.Struct({
    contents: Schema.String.check(Schema.isMaxLength(BOT_FILE_MAX_CHARS)).annotate({
      description: "The whole new Markdown file.",
    }),
  }),
  success: Saved,
})
  .annotate(Tool.Title, "Write Bot notes")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const PreferencesAppend = Tool.make("t3_bot_preferences_append", {
  ...shared,
  description: "Add one lasting user preference to your preferences.md.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)).annotate({
      description: "One line, in the user's terms.",
    }),
  }),
  success: Saved,
})
  .annotate(Tool.Title, "Add a Bot preference")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const WatchAdd = Tool.make("t3_bot_watch_add", {
  ...shared,
  description:
    "Wake you when a thread outside your crew, or a workflow run, here finishes or needs input. Ends when it settles. Your crew is always watched.",
  parameters: WatchTargetInput,
  success: Watches,
})
  .annotate(Tool.Title, "Watch a thread or workflow run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const WatchRemove = Tool.make("t3_bot_watch_remove", {
  ...shared,
  description: "Stop watching a thread or workflow run.",
  parameters: WatchTargetInput,
  success: Watches,
})
  .annotate(Tool.Title, "Stop watching")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

export const BotToolkit = Toolkit.make(
  MemoryRead,
  NotesWrite,
  PreferencesAppend,
  WatchAdd,
  WatchRemove,
);
