import {
  HomeNotes,
  HomeWatchesResult,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as HomeService from "../../../home/HomeService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { hiddenFromNonHomeThreads } from "../../homeAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HomeService.HomeService,
  ],
};

const WatchTargetInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  workflowRunId: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Instead of `threadId`." }),
  ),
});

const HomeNotesReadTool = Tool.make("home_notes_read", {
  ...shared,
  description: "Read Home's notes.md, your memory across fresh starts.",
  // No `parameters`: an explicit Schema.Struct({}) advertises `anyOf: [object, array]`,
  // which MCP clients reject. The default EmptyParams advertises `type: "object"`.
  success: HomeNotes,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromNonHomeThreads);

const HomeNotesWriteTool = Tool.make("home_notes_write", {
  ...shared,
  description: "Replace Home's notes.md with `text`. Read it first; keep it short.",
  parameters: HomeNotes,
  success: Schema.Struct({}),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromNonHomeThreads);

const HomeWatchAddTool = Tool.make("home_watch_add", {
  ...shared,
  description:
    "Wake Home when a thread or workflow run here finishes, needs input, or its watched pull request changes. Ends when it settles. Threads you launch are watched already.",
  parameters: WatchTargetInput,
  success: HomeWatchesResult,
}).annotate(McpSchema.EnabledWhen, hiddenFromNonHomeThreads);

const HomeWatchRemoveTool = Tool.make("home_watch_remove", {
  ...shared,
  description: "Stop watching a thread or workflow run.",
  parameters: WatchTargetInput,
  success: HomeWatchesResult,
}).annotate(McpSchema.EnabledWhen, hiddenFromNonHomeThreads);

const HomeWatchListTool = Tool.make("home_watch_list", {
  ...shared,
  description: "List what wakes Home.",
  success: HomeWatchesResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, hiddenFromNonHomeThreads);

export const HomeToolkit = Toolkit.make(
  HomeNotesReadTool,
  HomeNotesWriteTool,
  HomeWatchAddTool,
  HomeWatchRemoveTool,
  HomeWatchListTool,
);
