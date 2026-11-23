import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

export const USER_COMMANDS_FILE_NAME = "commands.json";

export const USER_COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
const USER_COMMAND_MAX_TIMEOUT_MS = 600_000;
const USER_COMMAND_MAX_ARGS_LENGTH = 4096;
const USER_COMMAND_MAX_ARGV = 64;
const USER_COMMAND_MAX_COMMANDS = 100;
const USER_COMMAND_MAX_ARGV_ENTRY_LENGTH = 4096;

/** Built into T3 Code; a user command with one of these names is ignored. */
export const BUILT_IN_SLASH_COMMAND_NAMES = ["model", "side", "btw", "clear"] as const;

export const UserCommandName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  Schema.isMaxLength(64),
).annotate({
  description:
    'Name typed after the slash, such as "graph" for /graph. Letters, digits, "-" and "_" only.',
});

export const UserCommandOutput = Schema.Literals(["markdown", "html"]).annotate({
  description:
    'How stdout is shown in the thread: "markdown" renders it as Markdown, "html" as an HTML page.',
});
export type UserCommandOutput = typeof UserCommandOutput.Type;

export const UserCommand = Schema.Struct({
  name: UserCommandName,
  description: TrimmedNonEmptyString.annotate({
    description: "One line shown next to the command in the / menu.",
  }),
  argumentHint: Schema.optionalKey(
    TrimmedNonEmptyString.annotate({
      description: 'Hint for the typed arguments in the / menu, such as "[all]".',
    }),
  ),
  run: Schema.Array(
    Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(USER_COMMAND_MAX_ARGV_ENTRY_LENGTH),
    ),
  )
    .check(Schema.isMinLength(1), Schema.isMaxLength(USER_COMMAND_MAX_ARGV))
    .annotate({
      description:
        'The program and its arguments, run without a shell in the thread\'s folder. A leading "~" expands to the home folder. Arguments typed after the command are appended.',
    }),
  output: UserCommandOutput,
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: USER_COMMAND_MAX_TIMEOUT_MS }),
    ).annotate({
      description: `Milliseconds before the command is stopped. Defaults to ${USER_COMMAND_DEFAULT_TIMEOUT_MS}.`,
    }),
  ),
}).annotate({
  description:
    "A slash command T3 Code runs itself, without an agent, and shows the output of in the thread.",
});
export type UserCommand = typeof UserCommand.Type;

/** The `commands` array of commands.json and t3.json. */
export const UserCommands = Schema.Array(UserCommand)
  .annotate({
    description:
      "Slash commands T3 Code runs without an agent. A command here replaces a user-wide one of the same name.",
  })
  .check(Schema.isMaxLength(USER_COMMAND_MAX_COMMANDS));

export const UserCommandsFile = Schema.Struct({ commands: UserCommands });
export type UserCommandsFile = typeof UserCommandsFile.Type;

export const UserCommandSource = Schema.Literals(["user", "project"]);
export type UserCommandSource = typeof UserCommandSource.Type;

/** What a client needs to offer a command; the program to run stays on the server. */
export const UserCommandSummary = Schema.Struct({
  name: UserCommandName,
  description: Schema.String,
  argumentHint: Schema.optionalKey(Schema.String),
  output: UserCommandOutput,
  source: UserCommandSource,
});
export type UserCommandSummary = typeof UserCommandSummary.Type;

export const UserCommandsListInput = Schema.Struct({ projectId: ProjectId });
export type UserCommandsListInput = typeof UserCommandsListInput.Type;

export const UserCommandsListResult = Schema.Struct({
  commands: Schema.Array(UserCommandSummary),
});
export type UserCommandsListResult = typeof UserCommandsListResult.Type;

export const UserCommandsRunInput = Schema.Struct({
  threadId: ThreadId,
  name: UserCommandName,
  /** Text typed after the command; split into arguments by the server. */
  args: Schema.String.check(Schema.isMaxLength(USER_COMMAND_MAX_ARGS_LENGTH)),
});
export type UserCommandsRunInput = typeof UserCommandsRunInput.Type;

/** The thread item that shows the run, written once the run ended. */
export const UserCommandsRunResult = Schema.Struct({ itemId: TurnItemId });
export type UserCommandsRunResult = typeof UserCommandsRunResult.Type;

export class UserCommandError extends Schema.TaggedError<UserCommandError>()("UserCommandError", {
  reason: Schema.Literals(["unknown-command", "thread-not-found", "unavailable"]),
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Same fields as an agent's `html_render` reference, so clients show it in the same frame. */
export const UserCommandHtmlRender = Schema.Struct({
  attachmentId: Schema.String,
  title: Schema.String,
  height: Schema.Number,
  heights: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.Int, Schema.Number]))),
});
export type UserCommandHtmlRender = typeof UserCommandHtmlRender.Type;
