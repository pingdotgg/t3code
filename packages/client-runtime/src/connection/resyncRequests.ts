import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * A manual "the client's view looks wrong, reconcile it" signal.
 *
 * Snapshot-backed subscriptions (shell, threads) already reconcile on a
 * foreground wake: they reload the HTTP snapshot and resume the stream from
 * its sequence. That is the same work a client restart does, and until now a
 * restart was the only way to ask for it. Callers that *observe* a
 * disagreement — a lifecycle command whose effect never lands in the local
 * view — can request it here instead of stranding the user.
 *
 * Deliberately not Effect-scoped: the callers are UI event handlers, and a
 * request is fire-and-forget. Requests raised before the wakeups layer is
 * built are dropped rather than buffered; there is nothing to reconcile
 * before the first subscription exists.
 */
export type ResyncListener = () => void;

const listeners = new Set<ResyncListener>();

/** Ask every snapshot-backed subscription to reconcile against the server.
 *
 *  One reconcile covers every thread in the environment, so callers that can
 *  fire in bursts (bulk lifecycle actions) should coalesce before calling
 *  this rather than asking once per item. */
export function requestResync(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Subscribe to resync requests. Returns an unsubscribe function. */
export function onResyncRequested(listener: ResyncListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resync requests as a `ConnectionWakeup` stream, for the wakeups layer. */
export const resyncRequestStream: Stream.Stream<"resync-requested"> =
  Stream.callback<"resync-requested">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => onResyncRequested(() => Queue.offerUnsafe(queue, "resync-requested"))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ).pipe(Effect.asVoid),
  );
