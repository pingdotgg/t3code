import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  FEEDBACK_CLI_CLIENT_LABEL,
  FeedbackInput,
  FeedbackReport,
} from "../feedback/FeedbackReport.ts";
import { projectLocationFlags } from "./config.ts";
import { jsonFlag, printJson, reportThreadErrors, withThreadTools } from "./thread.ts";

const feedbackListCommand = Command.make("list", { ...projectLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List recent feedback reports saved on this machine, newest first."),
  Command.withHandler((flags) =>
    withThreadTools(
      { ...flags, clientLabel: FEEDBACK_CLI_CLIENT_LABEL, quietLogs: flags.json },
      Effect.fn("cli.feedback.list")(function* (tools) {
        const { reports } = yield* tools.call(
          "t3_feedback_list",
          {},
          Schema.Struct({ reports: Schema.Array(FeedbackReport) }),
        );
        if (flags.json) return yield* printJson(reports);
        for (const report of reports) {
          yield* Console.log(
            [
              report.createdAt,
              report.threadId ?? "-",
              report.kind,
              report.subject || "-",
              report.sent ? "sent" : "local",
            ].join("  "),
          );
          yield* Console.log(`  expected: ${report.expected}`);
          yield* Console.log(`  actual: ${report.actual}`);
          if (report.workaround) yield* Console.log(`  workaround: ${report.workaround}`);
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);

export const feedbackCommand = Command.make("feedback", {
  ...projectLocationFlags,
  kind: Flag.Literals("kind", FeedbackInput.fields.kind.literals).pipe(
    Flag.withDescription("What went wrong."),
  ),
  subject: Flag.String("subject").pipe(
    Flag.withDescription("The T3 tool or t3 command, such as `t3 thread send`."),
    Flag.withDefault(""),
  ),
  expected: Flag.String("expected").pipe(Flag.withDescription("What you expected.")),
  actual: Flag.String("actual").pipe(Flag.withDescription("What happened instead.")),
  workaround: Flag.String("workaround").pipe(
    Flag.withDescription("What you did instead."),
    Flag.withDefault(""),
  ),
}).pipe(
  Command.withDescription(
    "Send a report about a T3 Code problem to the T3 team. Agent feedback must be on in Settings.",
  ),
  Command.withHandler(({ baseDir, kind, subject, expected, actual, workaround }) =>
    withThreadTools(
      { baseDir, clientLabel: FEEDBACK_CLI_CLIENT_LABEL, quietLogs: true },
      Effect.fn("cli.feedback.submit")(function* (tools) {
        const report = yield* tools.call(
          "t3_feedback",
          { kind, subject, expected, actual, workaround },
          FeedbackReport,
        );
        yield* printJson(report);
      }),
    ).pipe(reportThreadErrors),
  ),
  Command.withSubcommands([feedbackListCommand]),
);
