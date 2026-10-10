import { flushSync } from "react-dom";

type ResizeCallback = (entries: readonly ResizeObserverEntry[]) => void;

interface Subscription {
  readonly callback: ResizeCallback;
  active: boolean;
}

interface Target {
  readonly subscriptions: Set<Subscription>;
  /** Subscribers that joined after the first delivery and still await their initial entry. */
  waiting: Set<Subscription> | null;
  last: ResizeObserverEntry | null;
}

let observer: ResizeObserver | null = null;
const targets = new Map<Element, Target>();

function deliver(entries: readonly ResizeObserverEntry[]) {
  const batches = new Map<Subscription, ResizeObserverEntry[]>();
  for (const entry of entries) {
    const target = targets.get(entry.target);
    if (!target) continue;
    let recipients = target.subscriptions;
    if (target.waiting) {
      // Re-observing for a new subscriber redelivers an unchanged size to everyone else too.
      const previous = target.last?.contentRect;
      if (
        previous?.width === entry.contentRect.width &&
        previous.height === entry.contentRect.height
      ) {
        recipients = target.waiting;
      }
      target.waiting = null;
    }
    target.last = entry;
    for (const subscription of recipients) {
      const batch = batches.get(subscription);
      if (batch) batch.push(entry);
      else batches.set(subscription, [entry]);
    }
  }
  if (batches.size === 0) return;
  flushSync(() => {
    for (const [subscription, batch] of batches) {
      if (!subscription.active) continue;
      try {
        subscription.callback(batch);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  });
}

/**
 * Observes element sizes on one shared ResizeObserver. Its callbacks run after
 * layout and before paint, but React commits state set there after the paint,
 * so layout derived from an observed size would land one frame late. Every
 * resize delivered in a frame runs inside one flushSync, so all size-derived
 * state commits in a single render before that paint. A callback gets one call
 * with the entries for all of its targets, starting with an initial one each.
 */
export function observeResize(
  elements: Element | readonly Element[],
  callback: ResizeCallback,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const shared = (observer ??= new ResizeObserver(deliver));
  const subscription: Subscription = { callback, active: true };
  const observed: readonly Element[] = Array.isArray(elements) ? elements : [elements as Element];
  for (const element of observed) {
    const target = targets.get(element);
    if (!target) {
      targets.set(element, { subscriptions: new Set([subscription]), waiting: null, last: null });
      shared.observe(element);
      continue;
    }
    target.subscriptions.add(subscription);
    // An initial entry still pending reaches every subscriber; after it, only
    // observing afresh makes the browser report the current size again.
    if (!target.last) continue;
    (target.waiting ??= new Set()).add(subscription);
    shared.unobserve(element);
    shared.observe(element);
  }
  return () => {
    if (!subscription.active) return;
    subscription.active = false;
    const unobserved = observed.filter((element) => {
      const target = targets.get(element);
      if (!target?.subscriptions.delete(subscription)) return false;
      target.waiting?.delete(subscription);
      return target.subscriptions.size === 0 && targets.delete(element);
    });
    if (targets.size > 0) {
      for (const element of unobserved) shared.unobserve(element);
    } else {
      // A fresh observer next time also picks up a ResizeObserver a test stubbed since.
      observer?.disconnect();
      observer = null;
    }
  };
}
