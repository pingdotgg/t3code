import * as Schema from "effect/Schema";

// Code points, as the scrubber caps them, so a valid input stays a valid report after redaction.
const FeedbackText = Schema.String.check(Schema.isMaxCodePoints(300));

export const FeedbackInput = Schema.Struct({
  kind: Schema.Literals(["bug", "confusing", "missing_capability", "wrong_docs"]),
  subject: Schema.String.annotate({
    description: "The T3 tool name or `t3` command, such as `t3 thread send`.",
  }),
  expected: FeedbackText,
  actual: FeedbackText,
  workaround: FeedbackText.annotate({ description: "What you did instead, or empty." }),
});

export const FeedbackReport = Schema.Struct({
  ...FeedbackInput.fields,
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  source: Schema.Literals(["mcp", "cli"]),
  sent: Schema.Boolean,
});

/** The MCP client label `t3 feedback` signs in with, so its reports count as `cli`. */
export const FEEDBACK_CLI_CLIENT_LABEL = "t3 feedback cli";

/** Listed `t3` command paths a report may name. A CLI test keeps this in step with binCli. */
export const T3_CLI_COMMANDS: ReadonlyArray<string> = [
  "t3",
  "t3 help",
  "t3 serve",
  "t3 app",
  "t3 pair",
  "t3 auth",
  "t3 auth pairing",
  "t3 auth pairing create",
  "t3 auth pairing list",
  "t3 auth pairing revoke",
  "t3 auth session",
  "t3 auth session issue",
  "t3 auth session list",
  "t3 auth session revoke",
  "t3 environment",
  "t3 environment link",
  "t3 environment list",
  "t3 environment unlink",
  "t3 browser",
  "t3 browser setup",
  "t3 project",
  "t3 project add",
  "t3 project remove",
  "t3 project rename",
  "t3 thread",
  "t3 thread list",
  "t3 thread start",
  "t3 thread send",
  "t3 thread show",
  "t3 feedback",
  "t3 feedback list",
  "t3 up",
  "t3 status",
  "t3 service",
  "t3 service install",
  "t3 service restart",
  "t3 service uninstall",
  "t3 service status",
  "t3 service protect",
  "t3 update",
  "t3 install",
  "t3 uninstall",
  "t3 theme",
  "t3 theme set",
  "t3 theme clear",
  "t3 theme show",
  "t3 trace",
  "t3 trace summary",
  "t3 doctor",
  "t3 policy",
  "t3 policy show",
  "t3 policy check",
  "t3 policy templates",
  "t3 triage",
  "t3 connect",
  "t3 connect link",
  "t3 connect login",
  "t3 connect logout",
  "t3 connect publish",
  "t3 connect status",
  "t3 connect unlink",
];

export type FeedbackInput = typeof FeedbackInput.Type;
export type FeedbackReport = typeof FeedbackReport.Type;
