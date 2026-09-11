import type {
  CanonicalItemType,
  CanonicalRequestType,
  ProviderApprovalDecision,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
export const MuseResumeCursor = Schema.Struct({ sessionId: NonEmptyString });

export const MuseUsage = Schema.Struct({
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cachedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reasoningTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheReadTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  cacheWriteTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const MuseItem = Schema.Struct({
  itemId: NonEmptyString,
  kind: NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  status: NonEmptyString,
  turnId: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.Array(Schema.String)),
  tool: Schema.optional(Schema.String),
  args: Schema.optional(Schema.String),
  visibleOutput: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  failureReason: Schema.optional(Schema.String),
  fallbackText: Schema.optional(Schema.String),
  commandText: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
  durationMs: Schema.optional(Schema.Finite),
  subagentId: Schema.optional(Schema.String),
  childSessionId: Schema.optional(Schema.String),
  objective: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  controlStatus: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.Struct({ summary: Schema.String, text: Schema.optional(Schema.String) }),
  ),
  usage: Schema.optional(MuseUsage),
  outcome: Schema.optional(Schema.String),
  trigger: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type MuseItem = typeof MuseItem.Type;

export const MuseSessionResult = Schema.Struct({
  session: Schema.Struct({
    sessionId: NonEmptyString,
    modelId: Schema.optional(Schema.NullOr(Schema.String)),
    activeTurnId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  history: Schema.optional(
    Schema.Struct({
      items: Schema.NullOr(Schema.Array(MuseItem)),
      snapshot: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            schemaVersion: Schema.optional(Schema.Int),
            state: Schema.Struct({ items: Schema.Array(MuseItem) }),
          }),
        ),
      ),
    }),
  ),
});
export const MuseViewPage = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      method: Schema.String,
      params: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  nextCursor: Schema.NullOr(NonEmptyString),
});
export const MuseTurnStartResult = Schema.Struct({ turnId: NonEmptyString });

export const MuseApproval = Schema.Struct({
  approvalId: NonEmptyString,
  protectedWrite: Schema.optional(Schema.Boolean),
  judgeEscalated: Schema.optional(Schema.Boolean),
  sessionId: NonEmptyString,
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  rawArgs: Schema.optional(Schema.String),
  currentRequirementId: Schema.Struct({ approvalId: NonEmptyString, sourceIndex: Schema.Int }),
  availableChoices: Schema.Array(
    Schema.Struct({
      choiceId: NonEmptyString,
      label: Schema.String,
      decision: NonEmptyString,
      scope: Schema.String,
    }),
  ),
  subject: Schema.Struct({
    kind: Schema.String,
    access: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  }),
});
export type MuseApproval = typeof MuseApproval.Type;

export const MuseUserInput = Schema.Struct({
  userInputId: NonEmptyString,
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
  questions: Schema.Array(
    Schema.Struct({
      id: NonEmptyString,
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(
        Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) }),
      ),
      selection: Schema.Struct({
        mode: Schema.Literals(["single", "multiple"]),
        minSelections: Schema.optional(Schema.Int),
        maxSelections: Schema.optional(Schema.Int),
      }),
    }),
  ),
});
export type MuseUserInput = typeof MuseUserInput.Type;

export const MuseUserInputSettled = Schema.Struct({
  userInputId: NonEmptyString,
  answers: Schema.Array(
    Schema.Struct({
      questionId: NonEmptyString,
      selectedLabel: Schema.optional(Schema.String),
      selectedLabels: Schema.optional(Schema.Array(Schema.String)),
      freeText: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
    }),
  ),
});

export const MuseTokenUsageEvent = Schema.Struct({
  turnId: NonEmptyString,
  promptTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  usage: MuseUsage,
});
export const MuseContextUsage = Schema.Struct({
  usedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  windowTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export const MuseTodoList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ text: Schema.String, status: Schema.String })),
});
export const MuseTurnCompleted = Schema.Struct({
  turnId: NonEmptyString,
  terminal: NonEmptyString,
  reason: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
  usage: Schema.optional(MuseUsage),
});
export const MuseTurnRetryScheduled = Schema.Struct({
  turnId: NonEmptyString,
  nextAttempt: Schema.Int.check(Schema.isGreaterThan(0)),
  maxAttempts: Schema.Int.check(Schema.isGreaterThan(0)),
  reason: NonEmptyString,
  retryDelayMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const MuseCompactResult = Schema.Struct({
  status: Schema.String,
  reason: Schema.optional(Schema.String),
});

export const MuseItemEvent = Schema.Struct({ item: MuseItem });
export const MuseDelta = Schema.Struct({
  itemId: NonEmptyString,
  delta: Schema.String,
  field: Schema.optional(Schema.String),
});

export function museItemType(item: MuseItem): CanonicalItemType {
  switch (item.kind) {
    case "agentMessage":
      return "assistant_message";
    case "userMessage":
      return "user_message";
    case "reasoning":
      return "reasoning";
    case "compaction":
      return "context_compaction";
    case "userShell":
      return "command_execution";
    case "subagent":
      return "collab_agent_tool_call";
    case "toolCall": {
      const tool = item.tool?.toLowerCase() ?? "";
      if (/shell|bash|exec_command/.test(tool)) return "command_execution";
      if (/write|edit|patch/.test(tool)) return "file_change";
      if (/web|browse|fetch/.test(tool)) return "web_search";
      if (/image/.test(tool)) return "image_view";
      return "dynamic_tool_call";
    }
    default:
      // Generic tool activity is rendered by every client; canonical "unknown"
      // items are filtered out of the work log before they reach a client.
      return "dynamic_tool_call";
  }
}

export function museRequestType(approval: MuseApproval): CanonicalRequestType {
  if (approval.subject.kind === "shell") return "command_execution_approval";
  if (approval.subject.kind === "fileAccess") {
    return approval.subject.access === "read" ? "file_read_approval" : "file_change_approval";
  }
  return "dynamic_tool_call";
}

export function museApprovalDecision(
  choice: Pick<MuseApproval["availableChoices"][number], "decision" | "scope">,
): ProviderApprovalDecision | undefined {
  switch (choice.decision) {
    case "approved":
      return "accept";
    case "approvedForSession":
      return "acceptForSession";
    case "approvedPolicyAmendment":
      return choice.scope === "session" ? "acceptForSession" : "acceptAlways";
    case "denied":
    case "deniedPolicyAmendment":
      return "decline";
    case "abort":
      return "cancel";
    default:
      return undefined;
  }
}

/** The shared decision protocol exposes one native choice per canonical action. */
export function museApprovalChoices(approval: MuseApproval) {
  const choices = new Map<ProviderApprovalDecision, MuseApproval["availableChoices"][number]>();
  const rank = (choice: MuseApproval["availableChoices"][number]) =>
    (choice.scope === "once" ? 0 : choice.scope === "session" ? 2 : 4) +
    (choice.decision.endsWith("PolicyAmendment") ? 1 : 0);
  for (const choice of approval.availableChoices) {
    const decision = museApprovalDecision(choice);
    if (!decision) continue;
    const previous = choices.get(decision);
    if (!previous || rank(choice) < rank(previous)) choices.set(decision, choice);
  }
  return choices;
}
