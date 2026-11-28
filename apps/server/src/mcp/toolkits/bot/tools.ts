import {
  BotAvatarChoice,
  BotAvatarShape,
  BotNote,
  BotNoteSlug,
  BotNoteSummary,
  BotNoteWriteFields,
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

/** Listed only to Bot threads; tool search never offers them to others. */
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
    "Read your memory: the user's instructions (preferences.md), the index of your notes (slug, title, one-line summary), the threads and workflow runs you watch beyond your workers, and the user's other Bots here. Read a note with t3_bot_note_read when its summary says you need it.",
  // No `parameters`: an explicit Schema.Struct({}) advertises `anyOf: [object, array]`,
  // which MCP clients reject. The default EmptyParams advertises `type: "object"`.
  success: Schema.Struct({
    instructions: Schema.String,
    notes: Schema.Array(BotNoteSummary),
    watches: Schema.Array(BotWatch),
    /** The user's other Bots on this machine, to ask or hand work to with t3_thread_send. */
    bots: Schema.Array(Schema.Struct({ threadId: ThreadId, name: Schema.String })),
  }),
})
  .annotate(Tool.Title, "Read Bot memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const NoteRead = Tool.make("t3_bot_note_read", {
  ...shared,
  description: "Read one of your notes in full.",
  parameters: Schema.Struct({ slug: BotNoteSlug }),
  success: BotNote,
})
  .annotate(Tool.Title, "Read a Bot note")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const NoteWrite = Tool.make("t3_bot_note_write", {
  ...shared,
  description:
    "Create or replace one note: one topic per note (a project, an effort, a person, a decision log). The title and summary form your index, so make the summary say when the note matters. Read a note before replacing it.",
  parameters: Schema.Struct({
    ...BotNoteWriteFields,
    slug: BotNoteSlug.annotate({ description: "File name, e.g. `release-2-1`." }),
    summary: BotNoteWriteFields.summary.annotate({
      description: "One line for the index: what is in it and when to read it.",
    }),
    body: BotNoteWriteFields.body.annotate({ description: "The whole Markdown note." }),
  }),
  success: Saved,
})
  .annotate(Tool.Title, "Write a Bot note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const NoteDelete = Tool.make("t3_bot_note_delete", {
  ...shared,
  description: "Delete a note that is no longer useful, or that you merged into another.",
  parameters: Schema.Struct({ slug: BotNoteSlug }),
  success: Saved,
})
  .annotate(Tool.Title, "Delete a Bot note")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const NoteSearch = Tool.make("t3_bot_note_search", {
  ...shared,
  description:
    "Find notes whose title, summary or text contains a phrase (case-insensitive), with the first matching line.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  success: Schema.Struct({
    matches: Schema.Array(Schema.Struct({ ...BotNoteSummary.fields, excerpt: Schema.String })),
  }),
})
  .annotate(Tool.Title, "Search Bot notes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const PreferencesAppend = Tool.make("t3_bot_preferences_append", {
  ...shared,
  description:
    "Add one lasting user wish to the instructions in your preferences.md, in the user's terms.",
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

const AvatarSet = Tool.make("t3_bot_avatar_set", {
  ...shared,
  description:
    "Choose your avatar: a shape and a color. It shows beside your name in the sidebar and your chat.",
  parameters: Schema.Struct({
    shape: BotAvatarShape,
    color: BotAvatarChoice.fields.color.annotate({ description: "A #rrggbb color." }),
  }),
  success: Saved,
})
  .annotate(Tool.Title, "Set your Bot avatar")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const WatchAdd = Tool.make("t3_bot_watch_add", {
  ...shared,
  description:
    "Wake you when another thread that is not one of your workers, or a workflow run, here finishes or needs input. Ends when it settles. Your workers are always watched.",
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
  NoteRead,
  NoteWrite,
  NoteDelete,
  NoteSearch,
  PreferencesAppend,
  AvatarSet,
  WatchAdd,
  WatchRemove,
);
