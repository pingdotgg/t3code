import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Code points, as the scrubber caps them, so a valid input stays a valid report after redaction.
const FeedbackText = Schema.String.check(Schema.isMaxCodePoints(300));

export const FeedbackInput = Schema.Struct({
  kind: Schema.Literals(["bug", "confusing", "missing_capability", "wrong_docs", "other"]),
  subject: Schema.String.annotate({ description: "T3 tool name, `t3` command, or `general`." }),
  expected: FeedbackText,
  actual: FeedbackText,
  workaround: FeedbackText.annotate({ description: "What you did instead, or empty." }),
  userRequested: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))).annotate(
    { description: "The user asked for this report." },
  ),
});

export const FeedbackReport = Schema.Struct({
  ...FeedbackInput.fields,
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  source: Schema.Literals(["mcp", "cli"]),
  sent: Schema.Boolean,
});

export const FEEDBACK_OFF_MESSAGE =
  "Agent feedback is off. Turn it on in T3 Code under Settings > Labs, then try again.";

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
  "t3 auth connect-device",
  "t3 auth connect-device approve",
  "t3 auth connect-device list",
  "t3 auth connect-device revoke",
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

export const FEEDBACK_SUBJECT_MESSAGE =
  "Set subject to the exact T3 tool name, the t3 command, or `general`.";

// Claude names T3 tools `mcp__t3-code__<tool>`; Codex Code Mode names them `mcp__t3_code__<tool>`.
const PROVIDER_TOOL_PREFIX = /^mcp__t3[-_]code__/;

/** The stored subject, or undefined when the value names no T3 tool, `t3` command, or `general`. */
export const resolveFeedbackSubject = (value: string, toolNames: ReadonlyArray<string>) => {
  const subject = value.trim();
  if (subject === "general" || T3_CLI_COMMANDS.includes(subject)) return subject;
  const tool = subject.replace(PROVIDER_TOOL_PREFIX, "");
  return toolNames.includes(tool) ? tool : undefined;
};
