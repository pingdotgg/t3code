import type {
  TaskIntakeConversationRef,
  TaskIntakeExternalLinkKind,
  TaskIntakeSource,
} from "@t3tools/contracts";

export interface TaskIntakeExternalLinkIdentity {
  readonly kind: TaskIntakeExternalLinkKind;
  readonly externalId: string;
}

const ALLOWED_EXTERNAL_LINK_KINDS_BY_SOURCE = {
  linear: new Set<TaskIntakeExternalLinkKind>(["linear_issue"]),
  slack: new Set<TaskIntakeExternalLinkKind>(["slack_thread"]),
  support_email: new Set<TaskIntakeExternalLinkKind>(["support_email_thread"]),
  webhook: new Set<TaskIntakeExternalLinkKind>(["webhook_event"]),
} satisfies Record<TaskIntakeSource, ReadonlySet<TaskIntakeExternalLinkKind>>;

export function isValidTaskIntakeExternalLinkIdentity(input: {
  readonly source: TaskIntakeSource;
  readonly kind: TaskIntakeExternalLinkKind;
}): boolean {
  return ALLOWED_EXTERNAL_LINK_KINDS_BY_SOURCE[input.source].has(input.kind);
}

export function toTaskIntakeExternalLinkIdentity(
  conversation: TaskIntakeConversationRef,
): TaskIntakeExternalLinkIdentity {
  if (
    !isValidTaskIntakeExternalLinkIdentity({
      source: conversation.source,
      kind: conversation.externalLinkKind,
    })
  ) {
    throw new Error(
      `Invalid Task Intake External Link kind ${conversation.externalLinkKind} for source ${conversation.source}.`,
    );
  }

  return {
    kind: conversation.externalLinkKind,
    externalId: conversation.externalId,
  };
}
