import { AgentFeedbackKind, AgentFeedbackTrace } from "@lathe/contracts";
import { resolveLatheMcpToolId } from "@lathe/shared/latheMcpToolPresentation";
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
    description: "Lathe tool name, `lathe` command, or `general`.",
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

/** What `lathe_feedback` answers: the report, with only the size of what its trace attached. */
export const FeedbackSubmitResult = Schema.Struct({
  ...reportFields,
  ...storedFields,
  trace: Schema.NullOr(FeedbackTrace.mapFields(Struct.omit(["entries"]))),
});

export const FEEDBACK_AWAITING_APPROVAL_NOTE =
  "The user sees this report in a card and chooses there whether to send it and whether to include the conversation. Nothing is sent until they do, and you will not learn their choice. Do not wait for it or send it another way. Call again only if the user asks to change it; that shows a new card.";

/** What `lathe_feedback` answers for a requested report: shown to the user, not yet sent. */
export const FeedbackAwaitingApproval = Schema.Struct({
  status: Schema.Literal("awaiting_approval"),
  note: Schema.String,
});
export type FeedbackAwaitingApproval = typeof FeedbackAwaitingApproval.Type;

export const FEEDBACK_OFF_MESSAGE =
  "Agent feedback is off. Turn it on in Lathe under Settings > Labs, then try again.";

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
// Reports from no turn, such as `lathe feedback`, have no turn to count in.
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

/** The MCP client label `lathe feedback` signs in with, so its reports count as `cli`. */
export const FEEDBACK_CLI_CLIENT_LABEL = "lathe feedback cli";

/** Listed `lathe` command paths a report may name. A CLI test keeps this in step with binCli. */
export const LATHE_CLI_COMMANDS: ReadonlyArray<string> = [
  "lathe",
  "lathe help",
  "lathe serve",
  "lathe app",
  "lathe pair",
  "lathe auth",
  "lathe auth connect-device",
  "lathe auth connect-device approve",
  "lathe auth connect-device list",
  "lathe auth connect-device revoke",
  "lathe auth pairing",
  "lathe auth pairing create",
  "lathe auth pairing list",
  "lathe auth pairing revoke",
  "lathe auth session",
  "lathe auth session issue",
  "lathe auth session list",
  "lathe auth session revoke",
  "lathe environment",
  "lathe environment link",
  "lathe environment list",
  "lathe environment unlink",
  "lathe browser",
  "lathe browser setup",
  "lathe project",
  "lathe project add",
  "lathe project remove",
  "lathe project rename",
  "lathe thread",
  "lathe thread list",
  "lathe thread start",
  "lathe thread send",
  "lathe thread show",
  "lathe feedback",
  "lathe feedback list",
  "lathe workflow",
  "lathe workflow start",
  "lathe workflow list",
  "lathe workflow show",
  "lathe workflow resume",
  "lathe workflow cancel",
  "lathe workflow signal",
  "lathe workflow withdraw",
  "lathe workflow questions",
  "lathe workflow hooks",
  "lathe workflow store",
  "lathe workflow store list",
  "lathe workflow store set",
  "lathe workflow store delete",
  "lathe up",
  "lathe status",
  "lathe service",
  "lathe service install",
  "lathe service restart",
  "lathe service uninstall",
  "lathe service status",
  "lathe service protect",
  "lathe update",
  "lathe install",
  "lathe uninstall",
  "lathe theme",
  "lathe theme set",
  "lathe theme clear",
  "lathe theme show",
  "lathe trace",
  "lathe trace summary",
  "lathe doctor",
  "lathe policy",
  "lathe policy show",
  "lathe policy check",
  "lathe policy templates",
  "lathe policy settings",
  "lathe triage",
  "lathe connect",
  "lathe connect link",
  "lathe connect login",
  "lathe connect logout",
  "lathe connect publish",
  "lathe connect status",
  "lathe connect unlink",
];

export type FeedbackInput = typeof FeedbackInput.Type;
export type FeedbackReport = typeof FeedbackReport.Type;

export const FEEDBACK_SUBJECT_MESSAGE =
  "Set subject to the exact Lathe tool name, the lathe command, or `general`.";

// The shared resolver knows the presented tools; the prefix covers the rest, such as these.
// Codex also registers `lathe-direct` for Lathe tools it keeps out of Code Mode.
const LATHE_PREFIX =
  /^(?:mcp__(?:lathe|t3[-_]?code)(?:[-_]direct)?__|(?:lathe|t3[-_]?code)(?:[-_]direct)?[.:/])/iu;

/** The bare name of a registered Lathe tool however a provider prefixed it, else undefined. */
export const resolveLatheToolName = (name: string, toolNames: ReadonlyArray<string>) => {
  const tool = resolveLatheMcpToolId(name) ?? name.replace(LATHE_PREFIX, "");
  if (toolNames.includes(tool)) return tool;
  // OpenCode 2 prefixes tools with `lathe-<thread>_`, underscores and all: the longest name wins.
  if (!/^lathe-/iu.test(name)) return undefined;
  return toolNames
    .filter((candidate) => name.endsWith(`_${candidate}`))
    .toSorted((a, b) => b.length - a.length)[0];
};

/** The stored subject, or undefined when the value names no Lathe tool, `lathe` command, or `general`. */
export const resolveFeedbackSubject = (value: string, toolNames: ReadonlyArray<string>) => {
  const subject = value.trim();
  if (subject === "general" || LATHE_CLI_COMMANDS.includes(subject)) return subject;
  return resolveLatheToolName(subject, toolNames);
};
