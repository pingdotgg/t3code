type IntersectionCallback = (entry: IntersectionObserverEntry) => void;

export interface ObserveIntersectionOptions {
  /** A scroll container to intersect with instead of the viewport. */
  readonly root?: Element | null;
  readonly rootMargin?: string;
  readonly threshold?: number;
}

interface Subscription {
  readonly callback: IntersectionCallback;
  active: boolean;
}

interface Target {
  readonly subscriptions: Set<Subscription>;
  waiting: Set<Subscription> | null;
  last: IntersectionObserverEntry | null;
}

interface SharedObserver {
  readonly observer: IntersectionObserver;
  readonly targets: Map<Element, Target>;
}

// One observer per root and distinct option set.
const viewportObservers = new Map<string, SharedObserver>();
const elementRootObservers = new WeakMap<Element, Map<string, SharedObserver>>();

function deliver(shared: SharedObserver, entries: readonly IntersectionObserverEntry[]) {
  for (const entry of entries) {
    const target = shared.targets.get(entry.target);
    if (!target) continue;
    let recipients = target.subscriptions;
    if (target.waiting) {
      // Re-observing for a new subscriber redelivers an unchanged state to everyone else too.
      if (target.last?.isIntersecting === entry.isIntersecting) recipients = target.waiting;
      target.waiting = null;
    }
    target.last = entry;
    for (const subscription of recipients) {
      if (!subscription.active) continue;
      try {
        subscription.callback(entry);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}

function observersFor(root: Element): Map<string, SharedObserver> {
  let observers = elementRootObservers.get(root);
  if (!observers) {
    observers = new Map();
    elementRootObservers.set(root, observers);
  }
  return observers;
}

/**
 * Observes an element's intersection with the viewport, or with `root`, through
 * one shared IntersectionObserver per root and option set. Returns the unsubscribe, so it can be
 * returned from a ref callback.
 */
export function observeIntersection(
  element: Element,
  callback: IntersectionCallback,
  options: ObserveIntersectionOptions = {},
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  const root = options.root ?? null;
  const key = `${options.rootMargin ?? ""}|${options.threshold ?? 0}`;
  const observersForRoot = root === null ? viewportObservers : observersFor(root);
  let shared = observersForRoot.get(key);
  if (!shared) {
    const targets = new Map<Element, Target>();
    const created: SharedObserver = {
      targets,
      observer: new IntersectionObserver((entries) => deliver(created, entries), {
        ...(root === null ? {} : { root }),
        ...(options.rootMargin === undefined ? {} : { rootMargin: options.rootMargin }),
        ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
      }),
    };
    shared = created;
    observersForRoot.set(key, shared);
  }
  const owner = shared;
  const subscription: Subscription = { callback, active: true };
  const target = owner.targets.get(element);
  if (!target) {
    owner.targets.set(element, {
      subscriptions: new Set([subscription]),
      waiting: null,
      last: null,
    });
    owner.observer.observe(element);
  } else {
    target.subscriptions.add(subscription);
    if (target.last) {
      (target.waiting ??= new Set()).add(subscription);
      owner.observer.unobserve(element);
      owner.observer.observe(element);
    }
  }
  return () => {
    if (!subscription.active) return;
    subscription.active = false;
    const current = owner.targets.get(element);
    if (!current?.subscriptions.delete(subscription)) return;
    current.waiting?.delete(subscription);
    if (current.subscriptions.size > 0) return;
    owner.targets.delete(element);
    if (owner.targets.size > 0) {
      owner.observer.unobserve(element);
      return;
    }
    owner.observer.disconnect();
    observersForRoot.delete(key);
    if (root !== null && observersForRoot.size === 0) elementRootObservers.delete(root);
  };
}
