import * as Context from "effect/Context";

export interface ThreadViewersShape {
  /** Counts a client viewing `threadId` until the returned release runs. */
  readonly view: (threadId: string) => () => void;
  readonly isViewed: (threadId: string) => boolean;
}

export const make = (): ThreadViewersShape => {
  const viewers = new Map<string, number>();
  return {
    view: (threadId) => {
      viewers.set(threadId, (viewers.get(threadId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (viewers.get(threadId) ?? 1) - 1;
        if (remaining > 0) viewers.set(threadId, remaining);
        else viewers.delete(threadId);
      };
    },
    isViewed: (threadId) => viewers.has(threadId),
  };
};

// The default is one shared registry, so thread subscriptions and the provider batch agree.
export class ThreadViewers extends Context.Reference<ThreadViewersShape>(
  "t3/orchestration-v2/ThreadViewers",
  { defaultValue: make },
) {}
