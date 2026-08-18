/**
 * Client-side plumbing for the notification transport stream.
 *
 * A transport does two things over one socket: receive decided edges and report
 * back what it did with each one. Nothing here decides *whether* something is
 * notification-worthy — the server-side `NotificationReactor` already did — and
 * nothing here derives copy: the presentation strings travel with the edge.
 *
 * Two deliberate shapes:
 *
 * - The feed hands the UI a **bounded buffer** rather than the latest edge. A
 *   burst that lands inside one render batch would otherwise lose every edge but
 *   the last, and a lost edge is a notification nobody ever sees.
 * - The resume cursor is **per environment and per page lifetime**, starting
 *   empty. That makes "no catch-up on launch" (spec §5) structural: only a
 *   reconnect within a session has a sequence to resume from.
 */
import {
  NOTIFICATION_WS_METHODS,
  type EnvironmentId,
  type NotificationDecidedEdge,
  type NotificationStreamItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * How many undelivered edges the feed keeps. Comfortably above any burst a
 * single commit can produce, and small enough that a transport which stops
 * draining cannot grow without bound.
 */
export const NOTIFICATION_EDGE_BUFFER_LIMIT = 32;

export const EMPTY_NOTIFICATION_EDGES: ReadonlyArray<NotificationDecidedEdge> = [];

/**
 * Appends an edge to the feed buffer, emitting the new buffer.
 *
 * The `synchronized` marker advances nothing: it exists so a resuming transport
 * can tell catch-up from live, and this feed treats both the same.
 */
export function appendNotificationStreamItem(
  buffer: ReadonlyArray<NotificationDecidedEdge>,
  item: NotificationStreamItem,
): readonly [
  ReadonlyArray<NotificationDecidedEdge>,
  ReadonlyArray<ReadonlyArray<NotificationDecidedEdge>>,
] {
  if (item.kind === "synchronized") {
    return [buffer, []];
  }
  const appended = [...buffer, item.edge];
  const next =
    appended.length > NOTIFICATION_EDGE_BUFFER_LIMIT
      ? appended.slice(appended.length - NOTIFICATION_EDGE_BUFFER_LIMIT)
      : appended;
  return [next, [next]];
}

/**
 * Highest `triggeringSequence` a transport actually presented, remembered for
 * the life of the page. Absent until the first edge is handled, so the first
 * subscription of a session asks for no history at all.
 */
interface NotificationResumeCursor {
  readonly read: () => number | undefined;
  readonly record: (sequence: number) => void;
}

function createResumeCursor(): NotificationResumeCursor {
  let presented: number | undefined;
  return {
    read: () => presented,
    record: (sequence) => {
      if (presented === undefined || sequence > presented) {
        presented = sequence;
      }
    },
  };
}

/**
 * How long to wait before re-subscribing after an expected failure. A stream
 * that gives up for good would leave the transport silently dead for the rest of
 * the page's life, which looks exactly like "notifications are broken".
 */
const NOTIFICATION_RESUBSCRIBE_DELAY = "5 seconds";

function notificationEdgeStream(cursor: NotificationResumeCursor) {
  return subscribeDynamic(
    NOTIFICATION_WS_METHODS.subscribe,
    () =>
      Effect.sync(() => {
        const afterSequence = cursor.read();
        // Re-read per subscription attempt: a reconnect closes the gap it
        // opened, a first attempt asks for nothing.
        return afterSequence === undefined ? {} : { afterSequence };
      }),
    {
      onExpectedFailure: (cause) =>
        Effect.logWarning("Notification stream failed; retrying.", {
          cause: Cause.pretty(cause),
        }),
      retryExpectedFailureAfter: NOTIFICATION_RESUBSCRIBE_DELAY,
    },
  ).pipe(Stream.mapAccum(() => EMPTY_NOTIFICATION_EDGES, appendNotificationStreamItem));
}

export function createNotificationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const cursors = new Map<EnvironmentId, NotificationResumeCursor>();
  const cursorFor = (environmentId: EnvironmentId): NotificationResumeCursor => {
    const existing = cursors.get(environmentId);
    if (existing !== undefined) {
      return existing;
    }
    const created = createResumeCursor();
    cursors.set(environmentId, created);
    return created;
  };

  const edgeFeed = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(environmentId, notificationEdgeStream(cursorFor(environmentId))),
        { initialValue: EMPTY_NOTIFICATION_EDGES },
      )
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:notifications:edges:${environmentId}`),
      ),
  );

  return {
    edgeFeed,
    /**
     * Records an edge as presented so a reconnect resumes past it. Only edges a
     * transport actually handled count — resuming past an edge nobody saw would
     * lose it for good.
     */
    recordPresentedSequence: (environmentId: EnvironmentId, sequence: number): void => {
      cursorFor(environmentId).record(sequence);
    },
    reportTransportOutcome: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:notifications:report-transport-outcome",
      tag: NOTIFICATION_WS_METHODS.reportTransportOutcome,
    }),
  };
}
