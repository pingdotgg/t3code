import { flushSync } from "react-dom";

type ResizeCallback = (entries: readonly ResizeObserverEntry[]) => void;

interface Subscription {
  readonly callback: ResizeCallback;
  active: boolean;
}

interface Target {
  readonly subscriptions: Set<Subscription>;
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

/** Flushes callbacks together before paint; ordinary React updates would leave a stale frame. */
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
      observer?.disconnect();
      observer = null;
    }
  };
}
