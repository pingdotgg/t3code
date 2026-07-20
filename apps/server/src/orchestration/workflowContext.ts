import type {
  OrchestrationMessage,
  OrchestrationThread,
  WorkflowContextPolicy,
  WorkflowInputArtifact,
} from "@t3tools/contracts";

const DEFAULT_MAX_CONTEXT_CHARS = 24_000;

export interface BuildWorkflowContextInput {
  readonly parent: Pick<OrchestrationThread, "id" | "messages">;
  readonly policy: WorkflowContextPolicy;
  readonly selectedMessageIds?: ReadonlySet<string>;
  readonly summary?: string;
  readonly maxChars?: number;
}

function toContextMessage(message: OrchestrationMessage) {
  return {
    messageId: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
  } as const;
}

function withinCharBudget(
  messages: ReadonlyArray<OrchestrationMessage>,
  maxChars: number,
): { readonly messages: ReadonlyArray<OrchestrationMessage>; readonly truncated: boolean } {
  let remaining = maxChars;
  const result: OrchestrationMessage[] = [];

  // Prefer the latest requested context, while preserving chronological order
  // for the worker prompt.
  for (const message of messages.toReversed()) {
    if (message.text.length > remaining) {
      return { messages: result.toReversed(), truncated: true };
    }
    result.push(message);
    remaining -= message.text.length;
  }
  return { messages: result.toReversed(), truncated: false };
}

/**
 * Produces an immutable, deliberately scoped parent-context artifact. Callers
 * must opt into messages; no policy can accidentally copy a full transcript.
 */
export function buildWorkflowContextArtifact(
  input: BuildWorkflowContextInput,
): WorkflowInputArtifact {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const selected =
    input.policy === "selected-messages"
      ? input.parent.messages.filter(
          (message) => input.selectedMessageIds?.has(message.id) ?? false,
        )
      : [];
  const bounded = withinCharBudget(selected, maxChars);
  const summary = input.policy === "summary" ? input.summary?.trim() : undefined;

  return {
    kind: "input-context",
    contextPolicy: input.policy,
    parentThreadId: input.parent.id,
    messages: bounded.messages.map(toContextMessage),
    ...(summary ? { summary } : {}),
    truncated: bounded.truncated,
  };
}

export function renderWorkflowContextArtifact(artifact: WorkflowInputArtifact): string {
  const sections = ["Workflow parent context:"];
  if (artifact.summary) {
    sections.push(`Summary:\n${artifact.summary}`);
  }
  if (artifact.messages.length > 0) {
    const messages = artifact.messages
      .map((message) => `[${message.role}] ${message.text}`)
      .join("\n\n");
    sections.push(`Selected messages:\n${messages}`);
  }
  if (artifact.truncated) {
    sections.push("Context was truncated to the workflow context budget.");
  }
  return sections.join("\n\n");
}
