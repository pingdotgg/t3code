import { AgentFeedbackKind, AgentFeedbackTrace } from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// Code points, as the scrubber caps them, so a valid input stays a valid report after redaction.
const FeedbackText = Schema.String.check(Schema.isMaxCodePoints(300));

/** Turns the outline of a requested report covers at least. */
export const FEEDBACK_TRACE_TURNS = 5;

const reportFields = {
  kind: AgentFeedbackKind,
  subject: Schema.String.annotate({
    description: "Hyakki tool name, `hyakki` command, or `general`.",
  }),
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
  turns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description: "How many recent turns, counting this one, the problem spans.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(1))),
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

export const FEEDBACK_AWAITING_APPROVAL_NOTE =
  "The user sees this report in a card and chooses there whether to send it and whether to include the conversation. Nothing is sent until they do, and you will not learn their choice. Do not wait for it or send it another way. Call again only if the user asks to change it; that shows a new card.";

/** What `t3_feedback` answers for a requested report: shown to the user, not yet sent. */
export const FeedbackAwaitingApproval = Schema.Struct({
  status: Schema.Literal("awaiting_approval"),
  note: Schema.String,
});
export type FeedbackAwaitingApproval = typeof FeedbackAwaitingApproval.Type;

export const FEEDBACK_OFF_MESSAGE =
  "Agent feedback is off. Turn it on in Hyakki under Settings > Labs, then try again.";

export class FeedbackOffError extends Schema.TaggedError<FeedbackOffError>()(
  "FeedbackOffError",
  {},
) {
  override get message() {
    return FEEDBACK_OFF_MESSAGE;
  }
}

export type FeedbackSource = "mcp" | "cli";

// Requested reports count when their card is shown, unprompted ones when stored.
export const MAX_REPORTS_PER_TURN = 3;
// Reports from no turn, such as `hyakki feedback`, have no turn to count in.
export const MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR = 10;

export class FeedbackLimitError extends Schema.TaggedError<FeedbackLimitError>()(
  "FeedbackLimitError",
  { scope: Schema.Literals(["turn", "hour", "cards"]) },
) {
  override get message() {
    switch (this.scope) {
      case "turn":
        return `This turn already sent ${MAX_REPORTS_PER_TURN} agent feedback reports; nothing was sent.`;
      case "cards":
        return `This turn already showed the user ${MAX_REPORTS_PER_TURN} agent feedback reports to approve; nothing was shown.`;
      case "hour":
        return `This machine already sent ${MAX_REPORTS_OUTSIDE_TURNS_PER_HOUR} agent feedback reports outside a turn in the last hour; nothing was sent.`;
    }
  }
}

export class FeedbackNotRequestedError extends Schema.TaggedError<FeedbackNotRequestedError>()(
  "FeedbackNotRequestedError",
  { source: Schema.Literals(["mcp", "cli"]) },
) {
  override get message() {
    return this.source === "cli"
      ? "Agent feedback is set to When I ask: ask your agent in a thread to send it, so you can approve what is sent."
      : "Agent feedback is set to When I ask: send a report only when the user asks for one.";
  }
}

export class FeedbackStorageError extends Schema.TaggedError<FeedbackStorageError>()(
  "FeedbackStorageError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not save agent feedback.";
  }
}

/** The MCP client label `hyakki feedback` signs in with, so its reports count as `cli`. */
export const FEEDBACK_CLI_CLIENT_LABEL = "hyakki feedback cli";

/** Listed `hyakki` command paths a report may name. A CLI test keeps this in step with binCli. */
export const T3_CLI_COMMANDS: ReadonlyArray<string> = [
  "hyakki",
  "hyakki help",
  "hyakki serve",
  "hyakki app",
  "hyakki pair",
  "hyakki auth",
  "hyakki auth connect-device",
  "hyakki auth connect-device approve",
  "hyakki auth connect-device list",
  "hyakki auth connect-device revoke",
  "hyakki auth pairing",
  "hyakki auth pairing create",
  "hyakki auth pairing list",
  "hyakki auth pairing revoke",
  "hyakki auth session",
  "hyakki auth session issue",
  "hyakki auth session list",
  "hyakki auth session revoke",
  "hyakki environment",
  "hyakki environment link",
  "hyakki environment list",
  "hyakki environment unlink",
  "hyakki browser",
  "hyakki browser setup",
  "hyakki project",
  "hyakki project add",
  "hyakki project remove",
  "hyakki project rename",
  "hyakki thread",
  "hyakki thread list",
  "hyakki thread start",
  "hyakki thread send",
  "hyakki thread show",
  "hyakki feedback",
  "hyakki feedback list",
  "hyakki workflow",
  "hyakki workflow start",
  "hyakki workflow list",
  "hyakki workflow show",
  "hyakki workflow resume",
  "hyakki workflow cancel",
  "hyakki workflow signal",
  "hyakki workflow withdraw",
  "hyakki workflow questions",
  "hyakki workflow hooks",
  "hyakki workflow store",
  "hyakki workflow store list",
  "hyakki workflow store set",
  "hyakki workflow store delete",
  "hyakki up",
  "hyakki status",
  "hyakki service",
  "hyakki service install",
  "hyakki service restart",
  "hyakki service uninstall",
  "hyakki service status",
  "hyakki service protect",
  "hyakki update",
  "hyakki install",
  "hyakki uninstall",
  "hyakki theme",
  "hyakki theme set",
  "hyakki theme clear",
  "hyakki theme show",
  "hyakki trace",
  "hyakki trace summary",
  "hyakki doctor",
  "hyakki policy",
  "hyakki policy show",
  "hyakki policy check",
  "hyakki policy templates",
  "hyakki policy settings",
  "hyakki triage",
  "hyakki connect",
  "hyakki connect link",
  "hyakki connect login",
  "hyakki connect logout",
  "hyakki connect publish",
  "hyakki connect status",
  "hyakki connect unlink",
];

export type FeedbackInput = typeof FeedbackInput.Type;
export type FeedbackReport = typeof FeedbackReport.Type;

export const FEEDBACK_SUBJECT_MESSAGE =
  "Set subject to the exact Hyakki tool name, the hyakki command, or `general`.";

// The shared resolver knows the presented tools; the prefix covers the rest, such as these.
// Codex also registers `t3-code-direct` for Hyakki tools it keeps out of Code Mode.
const T3_PREFIX = /^(?:mcp__t3[-_]?code(?:[-_]direct)?__|t3[-_]?code(?:[-_]direct)?[.:/])/iu;

/** The bare name of a registered Hyakki tool however a provider prefixed it, else undefined. */
export const resolveT3ToolName = (name: string, toolNames: ReadonlyArray<string>) => {
  const tool = resolveT3McpToolId(name) ?? name.replace(T3_PREFIX, "");
  if (toolNames.includes(tool)) return tool;
  // OpenCode 2 prefixes tools with `t3-code-<thread>_`, underscores and all: the longest name wins.
  if (!/^t3-code-/iu.test(name)) return undefined;
  return toolNames
    .filter((candidate) => name.endsWith(`_${candidate}`))
    .toSorted((a, b) => b.length - a.length)[0];
};

/** The stored subject, or undefined when the value names no Hyakki tool, `hyakki` command, or `general`. */
export const resolveFeedbackSubject = (value: string, toolNames: ReadonlyArray<string>) => {
  const subject = value.trim();
  if (subject === "general" || T3_CLI_COMMANDS.includes(subject)) return subject;
  return resolveT3ToolName(subject, toolNames);
};
