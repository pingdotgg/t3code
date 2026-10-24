import {
  OrchestratorMcpFailure,
  ThreadCommandWatch,
  ThreadCommandWatchCommand,
  ThreadCommandWatchEveryMinutes,
  ThreadCommandWatchLabel,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Orchestrator.OrchestratorV2,
];

export class CommandWatchFailedError extends Schema.TaggedError<CommandWatchFailedError>()(
  "CommandWatchFailedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const CommandWatchToolError = Schema.Union([
  OrchestratorMcpFailure,
  CommandWatchFailedError,
]);
export type CommandWatchToolError = typeof CommandWatchToolError.Type;

export const WatchCommandInput = Schema.Struct({
  command: ThreadCommandWatchCommand.annotate({
    description:
      "Shell command to run, for example a gh or curl query filtered with jq or grep. It runs in this thread's workspace with the T3 server's environment.",
  }),
  label: ThreadCommandWatchLabel.annotate({
    description: "Short name the user sees for this watch, for example 'Maintainer reply on #123'.",
  }),
  everyMinutes: Schema.optional(
    ThreadCommandWatchEveryMinutes.annotate({
      description: "Minutes between runs, 1 to 1440. Defaults to 10.",
    }),
  ),
});
export type WatchCommandInput = typeof WatchCommandInput.Type;

export const UnwatchCommandInput = Schema.Struct({
  watchId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Watch to stop. Omit to stop every command watch on this thread.",
    }),
  ),
});
export type UnwatchCommandInput = typeof UnwatchCommandInput.Type;

export const CommandWatchesResult = Schema.Struct({
  /** The watch this call started or found, for `watch_command`. */
  watchId: Schema.optional(Schema.String),
  watches: Schema.Array(ThreadCommandWatch),
});
export type CommandWatchesResult = typeof CommandWatchesResult.Type;

const WatchCommandTool = Tool.make("watch_command", {
  description:
    "Have T3 Code run a shell command for this thread on an interval and wake you when it prints something new. Use it to wait on anything that is not a pull request (a discussion or issue reply, another repository's CI, a deploy, a release) instead of polling or sleeping. Write a read-only check whose output changes when there is news, for example the last few comments from other accounts plus the item's state. The first run only records what the check prints at that moment, so a state that already holds never wakes you: run the check yourself first if you need the current state. After that, a run that exits 0 with output that differs from what you last saw wakes you with that output. Exit 0 with no output, or exit 1 with nothing on stderr, is quiet, so grep and jq -e gates work. Any other exit, including exit 1 with anything on stderr, or a 60 second timeout is a failure, and 8 in a row stop the watch, so silence stages that write progress or warnings to stderr (curl -s, 2>/dev/null). Output over 4 KB stops it too, so keep the output small. The same output does not wake you twice, and the watch stops after 10 wakes or 7 days. It runs with the T3 server's environment, not yours: rely on tools already logged in on the server, and keep secrets out of the command, since the user sees it. While T3 Code watches, the thread stays in the user's Working list, not their inbox. When you hand the work back to the user, call unwatch_command first. Watching also ends when the user stops this thread, when the thread settles, is archived, or leaves Full access. Needs Full access. A subagent cannot watch: its parent thread does. Watching the same command again returns the existing watch unchanged: to change its interval or label, call unwatch_command first.",
  parameters: WatchCommandInput,
  success: CommandWatchesResult,
  failure: CommandWatchToolError,
  dependencies,
})
  .annotate(Tool.Title, "Watch command")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const UnwatchCommandTool = Tool.make("unwatch_command", {
  description:
    "Stop a command watch on this thread, or every command watch when watchId is omitted. Stopping a watch that already ended changes nothing.",
  parameters: UnwatchCommandInput,
  success: CommandWatchesResult,
  failure: CommandWatchToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop watching command")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CommandWatchesToolkit = Toolkit.make(WatchCommandTool, UnwatchCommandTool);
