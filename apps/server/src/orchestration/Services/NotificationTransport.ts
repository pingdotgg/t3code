/**
 * NotificationTransport — the server side of the notification transport
 * contract: hand decided edges to whoever is connected, and take back what they
 * did with them.
 *
 * Two rules this service exists to keep honest:
 *
 * - **A subscription is not a history replay.** Without `afterSequence` a
 *   subscriber receives only edges detected while it is connected. The cursor
 *   closes a reconnect gap inside one client session; it is not a
 *   while-you-were-away drain (the sidebar inbox is).
 * - **An outcome completes a row, it never dedups one.** A suppressed edge is
 *   recorded as suppressed, never as delivered, and the first transport to
 *   report wins so a second one cannot rewrite history.
 *
 * @module NotificationTransport
 */
import type {
  NotificationReportTransportOutcomeError,
  NotificationReportTransportOutcomeInput,
  NotificationStreamItem,
  NotificationSubscribeError,
  NotificationSubscribeInput,
  NotificationTransportOutcomeReport,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export interface NotificationTransportShape {
  /**
   * Build one subscriber's stream of decided edges. Requires a `Scope` because
   * the live feed is forked into a buffer bound to the subscription's lifetime —
   * the buffer must be attached before the catch-up read, or an edge detected
   * during that read is lost.
   */
  readonly subscribe: (
    input: NotificationSubscribeInput,
  ) => Effect.Effect<
    Stream.Stream<NotificationStreamItem>,
    NotificationSubscribeError,
    Scope.Scope
  >;

  /**
   * Complete an outbox row with the outcome a transport reports. The returned
   * report reflects the row as it now stands, which is how a transport that lost
   * the race learns the outcome it did not write.
   */
  readonly reportTransportOutcome: (
    input: NotificationReportTransportOutcomeInput,
  ) => Effect.Effect<NotificationTransportOutcomeReport, NotificationReportTransportOutcomeError>;
}

export class NotificationTransport extends Context.Service<
  NotificationTransport,
  NotificationTransportShape
>()("t3/orchestration/Services/NotificationTransport") {}
