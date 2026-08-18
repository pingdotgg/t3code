import type {
  NotificationDecidedEdge,
  NotificationKind,
  NotificationReportedTransportOutcome,
  ScopedThreadRef,
} from "@t3tools/contracts";

/**
 * What the web transport does with one decided edge.
 *
 * `duplicate` is the only outcome that reports nothing: the show that first
 * claimed the identity key already reported for it, and a second report would be
 * refused as a lost race anyway.
 */
export type NotificationToastDecision =
  | { readonly action: "skip"; readonly reason: "duplicate" }
  | {
      readonly action: "suppress";
      readonly outcome: Extract<NotificationReportedTransportOutcome, `suppressed:${string}`>;
    }
  | { readonly action: "show"; readonly outcome: "shown" };

/**
 * Suppress only when *that* thread is on screen in a focused tab. A tab focused
 * on a different thread still toasts — "the agent I am not looking at finished"
 * is exactly the thing worth saying — and a backgrounded tab toasts too, so the
 * notice is waiting when the user comes back.
 */
export function shouldSuppressToastForFocus(input: {
  readonly appFocused: boolean;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly environmentId: string;
  readonly edge: NotificationDecidedEdge;
}): boolean {
  if (!input.appFocused || input.activeThreadRef === null) {
    return false;
  }
  return (
    input.activeThreadRef.threadId === input.edge.threadId &&
    input.activeThreadRef.environmentId === input.environmentId
  );
}

/**
 * Gate order matches the desktop transport: duplicate, then the global setting,
 * then focus. Suppression is never a dedup — a suppressed edge is reported as
 * suppressed, never recorded as delivered.
 */
export function decideNotificationToast(input: {
  readonly edge: NotificationDecidedEdge;
  readonly environmentId: string;
  readonly notificationsEnabled: boolean;
  readonly appFocused: boolean;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly alreadyHandled: boolean;
}): NotificationToastDecision {
  if (input.alreadyHandled) {
    return { action: "skip", reason: "duplicate" };
  }
  if (!input.notificationsEnabled) {
    return { action: "suppress", outcome: "suppressed:disabled" };
  }
  if (
    shouldSuppressToastForFocus({
      appFocused: input.appFocused,
      activeThreadRef: input.activeThreadRef,
      environmentId: input.environmentId,
      edge: input.edge,
    })
  ) {
    return { action: "suppress", outcome: "suppressed:focused" };
  }
  return { action: "show", outcome: "shown" };
}

/**
 * A finished turn is good news, a failed one is an error, and the two attention
 * kinds are the app asking for something — which is a warning, not a success.
 */
export function notificationToastType(kind: NotificationKind): "success" | "error" | "warning" {
  switch (kind) {
    case "turn-completed":
      return "success";
    case "turn-failed":
      return "error";
    case "approval-required":
    case "user-input-required":
      return "warning";
  }
}

/**
 * Every string comes from the decided edge verbatim. Transports never re-derive
 * copy, so a wording change lands in the reactor and both surfaces agree.
 */
export function notificationToastContent(edge: NotificationDecidedEdge): {
  readonly title: string;
  readonly description: string;
} {
  const where = `${edge.projectTitle} · ${edge.threadTitle}`;
  return {
    title: edge.headline,
    description: edge.detail === null ? where : `${where} — ${edge.detail}`,
  };
}
