import { AgentFeedbackKind, AgentFeedbackTrace } from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// Code points, as the scrubber caps them, so a valid input stays a valid report after redaction.
const FeedbackText = Schema.String.check(Schema.isMaxCodePoints(300));

/** Turns the outline of a requested report covers, and the most `includeTurns` can name. */
export const FEEDBACK_TRACE_TURNS = 5;

const reportFields = {
  kind: AgentFeedbackKind,
  subject: Schema.String.annotate({ description: "T3 tool name, `t3` command, or `general`." }),
  expected: FeedbackText,
  actual: FeedbackText,
  workaround: FeedbackText.annotate({ description: "What you did instead, or empty." }),
  // Annotate before the default: an annotation after it never reaches the JSON schema.
  userRequested: Schema.Boolean.annotate({ description: "The user asked for this report." }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
};

export const FeedbackInput = Schema.Struct({
  ...reportFields,
  includeTurns: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: FEEDBACK_TRACE_TURNS }))
    .annotate({
      description:
        "Sends the user's messages and your replies from this many recent turns. 0 unless the user explicitly asks to include the conversation.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
});

export const FeedbackTrace = AgentFeedbackTrace;
export type FeedbackTrace = AgentFeedbackTrace;

const storedFields = {
  id: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  source: Schema.Literals(["mcp", "cli"]),
  sent: Schema.Boolean,
};

export const FeedbackReport = Schema.Struct({
  ...reportFields,
  ...storedFields,
  trace: Schema.NullOr(FeedbackTrace),
});

/** What `t3_feedback` answers: the report, with only the size of what its trace attached. */
export const FeedbackSubmitResult = Schema.Struct({
  ...reportFields,
  ...storedFields,
  trace: Schema.NullOr(FeedbackTrace.mapFields(Struct.omit(["entries"]))),
});

/** What `t3_feedback` answers when the user did not approve a requested report. */
export const FEEDBACK_NOT_APPROVED_NOTE = {
  declined:
    "The user did not approve this report, so nothing was sent. Do not send it, or any part of it, another way.",
  timed_out:
    "The user did not answer in time, so nothing was sent. Do not send it another way; ask again only if the user wants to.",
} as const;

export const FeedbackNotApproved = Schema.Struct({
  approved: Schema.Literal(false),
  status: Schema.Literals(["declined", "timed_out"]),
  note: Schema.String,
});
export type FeedbackNotApproved = typeof FeedbackNotApproved.Type;

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

// The shared resolver knows the presented tools; the prefix covers the rest, such as these.
// Codex also registers `t3-code-direct` for T3 tools it keeps out of Code Mode.
const T3_PREFIX = /^(?:mcp__t3[-_]?code(?:[-_]direct)?__|t3[-_]?code(?:[-_]direct)?[.:/])/iu;

/** The bare name of a registered T3 tool however a provider prefixed it, else undefined. */
export const resolveT3ToolName = (name: string, toolNames: ReadonlyArray<string>) => {
  const tool = resolveT3McpToolId(name) ?? name.replace(T3_PREFIX, "");
  return toolNames.includes(tool) ? tool : undefined;
};

/** The stored subject, or undefined when the value names no T3 tool, `t3` command, or `general`. */
export const resolveFeedbackSubject = (value: string, toolNames: ReadonlyArray<string>) => {
  const subject = value.trim();
  if (subject === "general" || T3_CLI_COMMANDS.includes(subject)) return subject;
  return resolveT3ToolName(subject, toolNames);
};
