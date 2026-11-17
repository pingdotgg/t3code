import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { readFeedbackReports } from "../feedback/FeedbackList.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";

import {
  FEEDBACK_CLI_CLIENT_LABEL,
  FEEDBACK_OFF_MESSAGE,
  FeedbackInput,
  FeedbackOffError,
  FeedbackSubmitResult,
} from "../feedback/FeedbackReport.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  projectLocationFlags,
  resolveCliAuthConfig,
} from "./config.ts";
import {
  jsonFlag,
  printJson,
  reportThreadErrors,
  ThreadToolFailedError,
  withThreadTools,
} from "./thread.ts";

/** The server hides the feedback tools from every session while the setting is off. */
const feedbackOff = ({ tool }: { readonly tool: string }) =>
  Effect.fail(new ThreadToolFailedError({ tool, detail: FEEDBACK_OFF_MESSAGE }));

class FeedbackListError extends Schema.TaggedError<FeedbackListError>()("FeedbackListError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

const firstLine = (error: { readonly _tag: string; readonly message?: unknown }) =>
  (typeof error.message === "string" && error.message.trim() !== ""
    ? error.message
    : error._tag
  ).split("\n")[0];

/** Reads this machine's database and settings directly, whether or not its server runs. */
const listReports = Effect.fn("cli.feedback.listReports")(function* (flags: CliAuthLocationFlags) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
    quietLogs: true,
  });
  return yield* Effect.gen(function* () {
    // Settings first, from the file alone, so Off never opens the database.
    const { agentFeedback } = yield* ServerSettings.readServerSettingsFromDisk;
    if (agentFeedback.mode === "off") return yield* new FeedbackOffError({});
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(dbPath))) return [];
    // Read-only: no setup, no migrations, no writes, whether or not a server runs.
    return yield* readFeedbackReports.pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
    );
  }).pipe(
    Effect.provide(ManagedPolicy.layer.pipe(Layer.provideMerge(ServerConfig.layer(config)))),
    Effect.provideService(References.MinimumLogLevel, "Error"),
  );
});

const feedbackListCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List recent feedback reports saved on this machine, newest first."),
  Command.withHandler(
    Effect.fn("cli.feedback.list")(
      function* (flags) {
        const reports = yield* listReports(flags);
        if (flags.json) return yield* printJson(reports);
        for (const report of reports) {
          yield* Console.log(
            [
              report.createdAt,
              report.threadId ?? "-",
              report.kind,
              report.subject || "-",
              report.userRequested ? "approved" : "unprompted",
              report.sent ? "sent" : "local",
            ].join("  "),
          );
          yield* Console.log(`  expected: ${report.expected}`);
          yield* Console.log(`  actual: ${report.actual}`);
          if (report.workaround) yield* Console.log(`  workaround: ${report.workaround}`);
          if (report.trace) {
            const { turns, textTurns, entries } = report.trace;
            yield* Console.log(
              `  trace: outline of ${turns} turns (${entries.length} entries), text of ${textTurns}`,
            );
          }
        }
      },
      // Every failure is one line on stderr; the runtime does not log it again.
      Effect.catch((error) => {
        const detail =
          error._tag === "FeedbackOffError"
            ? error.message
            : `Could not read this machine's feedback reports: ${firstLine(error)}`;
        return Console.error(detail).pipe(
          Effect.andThen(Effect.fail(new FeedbackListError({ detail }))),
        );
      }),
    ),
  ),
);

export const feedbackCommand = Command.make("feedback", {
  ...projectLocationFlags,
  kind: Flag.Literals("kind", FeedbackInput.fields.kind.literals).pipe(
    Flag.withDescription("What went wrong."),
  ),
  subject: Flag.String("subject").pipe(
    Flag.withDescription("The T3 tool name, t3 command such as `t3 thread send`, or `general`."),
  ),
  expected: Flag.String("expected").pipe(Flag.withDescription("What you expected.")),
  actual: Flag.String("actual").pipe(Flag.withDescription("What happened instead.")),
  workaround: Flag.String("workaround").pipe(
    Flag.withDescription("What you did instead."),
    Flag.withDefault(""),
  ),
}).pipe(
  Command.withDescription(
    "Send feedback about T3 Code to the T3 team. Needs Agent feedback set to Automatic in Settings > Labs; to approve a report first, ask your agent in a thread.",
  ),
  Command.withHandler(({ baseDir, kind, subject, expected, actual, workaround }) =>
    withThreadTools(
      { baseDir, json: true, clientLabel: FEEDBACK_CLI_CLIENT_LABEL },
      Effect.fn("cli.feedback.submit")(function* (tools) {
        const report = yield* tools.call(
          "t3_feedback",
          { kind, subject, expected, actual, workaround },
          FeedbackSubmitResult,
        );
        yield* printJson(report);
      }),
    ).pipe(Effect.catchTags({ ThreadToolMissingError: feedbackOff }), reportThreadErrors),
  ),
  Command.withSubcommands([feedbackListCommand]),
);
