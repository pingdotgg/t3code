import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

import { AuthOrchestrationOperateScope, sessionGrantsScope } from "./auth.ts";
import { AuthSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderRequestKind } from "./providerPolicy.ts";

/**
 * Route approval asks to a person (or any operator), with an audited
 * permit-when-nobody fallback. Inspired by OpenRig `rig seat set-permissions-to`.
 * Extends pending runtime-request approvals; not a Slack/external channel.
 */
export const PermissionRoutingApprover = Schema.Union([
  Schema.Struct({ type: Schema.Literal("any-operator") }),
  Schema.Struct({
    type: Schema.Literal("subject"),
    /** Pairing-link / session grant subject that should see the ask first. */
    subject: TrimmedNonEmptyString,
  }),
]);
export type PermissionRoutingApprover = typeof PermissionRoutingApprover.Type;

export const PermissionRoutingWhenNobody = Schema.Literals(["wait", "permit"]);
export type PermissionRoutingWhenNobody = typeof PermissionRoutingWhenNobody.Type;

export const PermissionRoutingPolicy = Schema.Struct({
  defaultApprover: PermissionRoutingApprover,
  whenNobody: PermissionRoutingWhenNobody,
});
export type PermissionRoutingPolicy = typeof PermissionRoutingPolicy.Type;

export const DEFAULT_PERMISSION_ROUTING_POLICY: PermissionRoutingPolicy = {
  defaultApprover: { type: "any-operator" },
  whenNobody: "wait",
};

/** Stamped onto a pending approval so clients know who it is routed to. */
export const PermissionRequestRouting = Schema.Struct({
  assignee: PermissionRoutingApprover,
  whenNobody: PermissionRoutingWhenNobody,
  routedAt: Schema.DateTimeUtc,
});
export type PermissionRequestRouting = typeof PermissionRequestRouting.Type;

export const PermissionRequestResolvedBy = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("human"),
    subject: Schema.optionalKey(TrimmedNonEmptyString),
    sessionId: Schema.optionalKey(AuthSessionId),
    label: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    source: Schema.Literal("policy-nobody-permit"),
    detail: TrimmedNonEmptyString,
  }),
]);
export type PermissionRequestResolvedBy = typeof PermissionRequestResolvedBy.Type;

const APPROVAL_REQUEST_KINDS = new Set<string>(ProviderRequestKind.literals);

export const isPermissionApprovalKind = (kind: string): kind is ProviderRequestKind =>
  APPROVAL_REQUEST_KINDS.has(kind);

export function buildPermissionRequestRouting(
  policy: PermissionRoutingPolicy,
  routedAt: DateTime.Utc,
): PermissionRequestRouting {
  return {
    assignee: policy.defaultApprover,
    whenNobody: policy.whenNobody,
    routedAt,
  };
}

export interface PermissionRoutingSessionSnapshot {
  readonly subject: string;
  readonly connected: boolean;
  readonly authenticated?: boolean;
  readonly scopes?: ReadonlyArray<string>;
  readonly permissions?: ReadonlyArray<string>;
}

/** Connected sessions that can operate (approve) on this environment. */
function connectedOperatorSessions(
  sessions: ReadonlyArray<PermissionRoutingSessionSnapshot>,
): ReadonlyArray<PermissionRoutingSessionSnapshot> {
  return sessions.filter(
    (session) =>
      session.connected &&
      sessionGrantsScope(
        {
          authenticated: session.authenticated ?? true,
          scopes: session.scopes as never,
          permissions: session.permissions as never,
        },
        AuthOrchestrationOperateScope,
      ),
  );
}

/** Whether someone matching the assignee is online and able to approve. */
export function assigneeIsPresent(
  assignee: PermissionRoutingApprover,
  sessions: ReadonlyArray<PermissionRoutingSessionSnapshot>,
): boolean {
  const operators = connectedOperatorSessions(sessions);
  if (assignee.type === "any-operator") return operators.length > 0;
  return operators.some((session) => session.subject === assignee.subject);
}

export function shouldPermitWhenNobody(
  routing: Pick<PermissionRequestRouting, "assignee" | "whenNobody">,
  sessions: ReadonlyArray<PermissionRoutingSessionSnapshot>,
): boolean {
  return routing.whenNobody === "permit" && !assigneeIsPresent(routing.assignee, sessions);
}

export function nobodyPermitResolvedBy(
  routing: Pick<PermissionRequestRouting, "assignee">,
): PermissionRequestResolvedBy {
  const detail =
    routing.assignee.type === "any-operator"
      ? "No connected operator was available; permitted by permission-routing policy."
      : `Assignee subject "${routing.assignee.subject}" was not connected; permitted by permission-routing policy.`;
  return {
    source: "policy-nobody-permit",
    detail: TrimmedNonEmptyString.make(detail),
  };
}

/** Soft UI preference: whether this session is the routed assignee (any-operator matches all operators). */
export function isPermissionRoutedToSession(
  routing: Pick<PermissionRequestRouting, "assignee">,
  session: PermissionRoutingSessionSnapshot,
): boolean {
  if (!session.connected) return false;
  if (
    !sessionGrantsScope(
      {
        authenticated: session.authenticated ?? true,
        scopes: session.scopes as never,
        permissions: session.permissions as never,
      },
      AuthOrchestrationOperateScope,
    )
  ) {
    return false;
  }
  return routing.assignee.type === "any-operator" || routing.assignee.subject === session.subject;
}
