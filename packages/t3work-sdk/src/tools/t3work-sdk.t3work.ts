import * as Schema from "effect/Schema";

import { t3workThreadWrite } from "../t3work-sdk.groups.ts";
import { defineTool } from "../t3work-sdk.ts";

export const RenameThreadToolArgs = Schema.Struct({
  title: Schema.String,
});
export type RenameThreadToolArgs = typeof RenameThreadToolArgs.Type;

export const RenameThreadToolResult = Schema.Struct({
  ok: Schema.Literal(true),
  title: Schema.String,
  threadId: Schema.optional(Schema.String),
});
export type RenameThreadToolResult = typeof RenameThreadToolResult.Type;

export const renameThreadTool = defineTool({
  id: "t3work.thread.rename",
  group: t3workThreadWrite,
  args: RenameThreadToolArgs,
  result: RenameThreadToolResult,
  handler: async (args, ctx) => {
    const title = args.title.trim();
    if (title.length === 0) {
      throw new Error("t3work.thread.rename requires a non-empty 'title'.");
    }
    if (!ctx.t3work) {
      throw new Error("t3work.thread.rename requires a t3work tool client in ToolHandlerCtx.");
    }
    return await ctx.t3work.renameThread({ title });
  },
});
