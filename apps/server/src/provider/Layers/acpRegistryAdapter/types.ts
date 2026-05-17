import {
  type ApprovalRequestId,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import type * as Deferred from "effect/Deferred";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

import type { AcpMultiSessionShape } from "../../acp/AcpMultiSession.ts";

export interface EventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export type MakeEventStamp = () => Effect.Effect<EventStamp>;

export type OfferRuntimeEvent = (event: ProviderRuntimeEvent) => Effect.Effect<void>;

export interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export interface AcpRegistrySessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpMultiSessionShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

export interface AcpRegistryHandlerContext {
  readonly provider: ProviderDriverKind;
  readonly makeEventStamp: MakeEventStamp;
  readonly makeApprovalRequestId: () => Effect.Effect<ApprovalRequestId>;
  readonly offerRuntimeEvent: OfferRuntimeEvent;
}
