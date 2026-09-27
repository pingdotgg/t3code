/**
 * MSP wire shapes and the MSP → canonical-event mapping helpers.
 *
 * The wire interfaces intentionally cover only the fields the adapter reads.
 * MSP is open-evolving (`x-msp-openness`), so unknown fields must be ignored,
 * never enumerated.
 */
import type {
  CanonicalItemType,
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeContentStreamKind,
  RuntimeItemStatus,
  RuntimeSessionState,
  RuntimeTurnState,
  UserInputQuestion,
} from "@t3tools/contracts";

export interface MspSessionInfo {
  readonly sessionId: string;
  readonly status: string;
  readonly modelId: string | null;
  readonly activeTurnId: string | null;
  readonly workspaceRoot: string | null;
  readonly approvalMode?: { readonly mode?: string };
}

export interface MspItem {
  readonly itemId: string;
  readonly kind: string;
  readonly status: string;
  readonly revision: number;
  readonly turnId?: string | null;
  readonly text?: string;
  readonly tool?: string;
  readonly args?: string;
  readonly commandText?: string;
  readonly visibleOutput?: string;
  readonly failureReason?: string;
  readonly fallbackText?: string;
  readonly patchSummary?: {
    readonly files: number;
    readonly added: number;
    readonly removed: number;
  };
  readonly outputRef?: unknown;
  readonly usage?: MspTokenUsage;
  readonly exitCode?: number;
}

export interface MspTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface MspApprovalRequirementRef {
  readonly approvalId: string;
  readonly sourceIndex: number;
}

export interface MspApprovalChoice {
  readonly choiceId: string;
  readonly label: string;
  readonly decision: string;
  readonly scope: string;
  readonly acceptsFeedback?: boolean;
}

export interface MspApprovalSubject {
  readonly kind: string;
  readonly command?: string;
  readonly path?: string;
  readonly access?: string;
  readonly target?: string;
  readonly toolName?: string;
  readonly host?: string;
  readonly port?: number;
  readonly origin?: { readonly kind: string; readonly command?: string; readonly url?: string };
}

export interface MspApprovalRequest {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly rawArgs: string;
  readonly availableChoices: ReadonlyArray<MspApprovalChoice>;
  readonly currentRequirementId: MspApprovalRequirementRef;
  readonly subject: MspApprovalSubject;
}

export interface MspUserInputOption {
  readonly label: string;
  readonly description?: string;
}

export interface MspUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<MspUserInputOption>;
  readonly selection: { readonly mode: string };
}

export interface MspUserInputRequest {
  readonly userInputId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly questions: ReadonlyArray<MspUserInputQuestion>;
}

export interface MspTurnCompleted {
  readonly sessionId: string;
  readonly turnId: string;
  readonly terminal: string;
  readonly reason?: string;
  readonly durationMs?: number;
  readonly error?: { readonly kind: string; readonly message: string; readonly retryable: boolean };
  readonly usage?: MspTokenUsage;
}

export interface MspSessionTokenUsage {
  readonly sessionId: string;
  readonly turnId: string;
  readonly promptTokens: number;
  readonly totalTokens: number;
  readonly durationMs?: number;
  readonly usage: MspTokenUsage;
  readonly cumulative: {
    readonly promptTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}

export interface MspSessionContextUsage {
  readonly sessionId: string;
  readonly usedTokens: number;
  readonly windowTokens?: number;
}

export function mspSessionStateToRuntime(status: string): RuntimeSessionState {
  switch (status) {
    case "running":
      return "running";
    case "notLoaded":
      return "stopped";
    default:
      return "waiting";
  }
}

export function mspTurnTerminalToRuntime(terminal: string): RuntimeTurnState {
  switch (terminal) {
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "completed";
  }
}

export function mspItemStatusToRuntime(status: string): RuntimeItemStatus {
  switch (status) {
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "rejected":
      return "declined";
    default:
      return "failed";
  }
}

const SHELL_TOOL_NAMES = new Set(["shell", "bash", "exec", "local_shell", "run_command"]);
const EDIT_TOOL_NAMES = new Set([
  "edit",
  "write",
  "apply_patch",
  "edit_file",
  "write_file",
  "create_file",
]);
const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch", "search_web", "fetch_url"]);

export function mspToolNameToItemType(tool: string | undefined): CanonicalItemType {
  const normalized = tool?.toLowerCase().replace(/[^a-z0-9_]/g, "_") ?? "";
  if (
    SHELL_TOOL_NAMES.has(normalized) ||
    normalized.includes("shell") ||
    normalized.includes("bash")
  ) {
    return "command_execution";
  }
  if (
    EDIT_TOOL_NAMES.has(normalized) ||
    normalized.includes("edit") ||
    normalized.includes("patch")
  ) {
    return "file_change";
  }
  if (WEB_TOOL_NAMES.has(normalized) || normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.startsWith("mcp__") || normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return "dynamic_tool_call";
}

export function mspItemToCanonicalType(item: MspItem): CanonicalItemType {
  switch (item.kind) {
    case "userMessage":
      return "user_message";
    case "agentMessage":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "toolCall":
      return mspToolNameToItemType(item.tool);
    case "userShell":
      return "command_execution";
    case "subagent":
    case "workflow":
      return "collab_agent_tool_call";
    case "compaction":
      return "context_compaction";
    default:
      return "unknown";
  }
}

export function mspItemTitle(item: MspItem): string | undefined {
  switch (item.kind) {
    case "toolCall":
      return item.tool;
    case "userShell":
      return item.commandText;
    case "subagent":
      return "Subagent";
    case "workflow":
      return "Workflow";
    case "compaction":
      return "Context compaction";
    case "reminderChild":
      return "Reminder agent";
    default:
      return item.fallbackText;
  }
}

export function mspItemDetail(item: MspItem): string | undefined {
  switch (item.kind) {
    case "toolCall":
      return item.failureReason ?? item.args;
    case "userShell":
    case "agentMessage":
    case "reasoning":
      return undefined;
    default:
      return item.fallbackText ?? item.text;
  }
}

export function mspDeltaToStreamKind(
  item: MspItem | undefined,
  field: string | undefined,
): RuntimeContentStreamKind {
  const path = field ?? "text";
  if (!item) return "unknown";
  if (item.kind === "agentMessage" && path === "text") return "assistant_text";
  if (item.kind === "reasoning") {
    return path.startsWith("summary") ? "reasoning_summary_text" : "reasoning_text";
  }
  if (path === "output" || path === "visibleOutput") return "command_output";
  return "unknown";
}

export function mspApprovalRequestType(subject: MspApprovalSubject): CanonicalRequestType {
  switch (subject.kind) {
    case "shell":
    case "process":
      return "exec_command_approval";
    case "fileAccess":
      return subject.access === "read" ? "file_read_approval" : "file_change_approval";
    case "tool":
      return "mcp_elicitation_approval";
    default:
      return "unknown";
  }
}

export function mspApprovalDetail(request: MspApprovalRequest): string {
  const subject = request.subject;
  switch (subject.kind) {
    case "shell":
    case "process":
      return subject.command ?? request.rawArgs;
    case "fileAccess":
      return `${subject.access ?? "access"} ${subject.path ?? ""}`.trim();
    case "network":
      return subject.host
        ? `${subject.host}${subject.port ? `:${subject.port}` : ""}`
        : "network access";
    case "tool":
      return subject.toolName ?? request.toolName;
    default:
      return subject.target ?? request.rawArgs;
  }
}

export function mspDecisionToCanonical(decision: string): ProviderApprovalDecision {
  switch (decision) {
    case "approved":
      return "accept";
    case "approvedForSession":
      return "acceptForSession";
    case "approvedPolicyAmendment":
      return "acceptAlways";
    case "denied":
    case "deniedPolicyAmendment":
      return "decline";
    default:
      return "cancel";
  }
}

export function mspChoicesToOptions(
  choices: ReadonlyArray<MspApprovalChoice>,
): ReadonlyArray<ProviderApprovalOption> {
  return choices.map((choice) => ({
    decision: mspDecisionToCanonical(choice.decision),
    label: choice.label,
  }));
}

export function mspChoiceIdForDecision(
  choices: ReadonlyArray<MspApprovalChoice>,
  decision: ProviderApprovalDecision,
): string | undefined {
  const wanted = new Set<ProviderApprovalDecision>([decision]);
  const ranked = choices.map((choice, index) => ({
    choice,
    index,
    canonical: mspDecisionToCanonical(choice.decision),
  }));
  const exact = ranked.filter((entry) => wanted.has(entry.canonical));
  if (exact.length > 0) {
    // Prefer the narrowest grant for the same canonical decision.
    const scopeRank = (scope: string) => (scope === "once" ? 0 : scope === "session" ? 1 : 2);
    exact.sort(
      (a, b) => scopeRank(a.choice.scope) - scopeRank(b.choice.scope) || a.index - b.index,
    );
    return exact[0]?.choice.choiceId;
  }
  if (decision === "cancel") {
    return (
      ranked.find((entry) => entry.choice.decision === "abort")?.choice.choiceId ??
      ranked.find((entry) => entry.canonical === "decline")?.choice.choiceId
    );
  }
  return undefined;
}

export function mspQuestionsToCanonical(
  questions: ReadonlyArray<MspUserInputQuestion>,
): ReadonlyArray<UserInputQuestion> {
  return questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description ?? option.label,
    })),
    multiSelect: question.selection.mode === "multiple",
  }));
}

export interface MspUserInputAnswer {
  readonly questionId: string;
  readonly selectedLabel?: string;
  readonly selectedLabels?: ReadonlyArray<string>;
  readonly freeText?: string;
  readonly note?: string;
}

export function canonicalAnswerToMsp(questionId: string, value: unknown): MspUserInputAnswer {
  if (typeof value === "string") {
    return { questionId, selectedLabel: value };
  }
  if (Array.isArray(value)) {
    return {
      questionId,
      selectedLabels: value.filter((entry): entry is string => typeof entry === "string"),
    };
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const answer: {
      questionId: string;
      selectedLabel?: string;
      selectedLabels?: ReadonlyArray<string>;
      freeText?: string;
      note?: string;
    } = { questionId };
    if (typeof record.selectedLabel === "string") answer.selectedLabel = record.selectedLabel;
    if (Array.isArray(record.selectedLabels)) {
      answer.selectedLabels = record.selectedLabels.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
    if (Array.isArray(record.answers)) {
      const labels = record.answers.filter((entry): entry is string => typeof entry === "string");
      const first = labels[0];
      if (labels.length === 1 && first !== undefined) {
        answer.selectedLabel = first;
      } else if (labels.length > 0) {
        answer.selectedLabels = labels;
      }
    }
    if (typeof record.freeText === "string") answer.freeText = record.freeText;
    if (typeof record.note === "string") answer.note = record.note;
    return answer;
  }
  return { questionId };
}
