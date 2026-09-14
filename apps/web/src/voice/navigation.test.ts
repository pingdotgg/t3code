import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ThreadId, VoiceTimingMark, VoiceToolError } from "@t3tools/contracts";

import {
  createVoiceNavigator,
  expectedThreadRoutePath,
  THREAD_ROUTE_TO,
  type VoiceEnvironmentReachability,
  type VoiceNavigationDestination,
  type VoiceNavigatorDeps,
  type VoiceRouteDriver,
} from "./navigation.ts";

const DESTINATION: VoiceNavigationDestination = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-1" as ThreadId,
};

const OTHER_DESTINATION: VoiceNavigationDestination = {
  environmentId: "env-1" as EnvironmentId,
  threadId: "thread-2" as ThreadId,
};

interface DriverHarness {
  driver: VoiceRouteDriver;
  /** Ordered log of driver interactions, interleaved with mark emissions. */
  readonly order: string[];
  readonly navigations: Array<{
    readonly to: string;
    readonly params: VoiceNavigationDestination;
    readonly replace: boolean | undefined;
  }>;
  /** Handlers for pending navigate calls, resolvable by the test. */
  readonly pending: Array<() => void>;
  path: string;
  readonly pathListeners: Array<(path: string) => void>;
  readonly marks: Array<{ mark: VoiceTimingMark; detail?: string }>;
  readonly lateRedirects: VoiceToolError[];
}

const makeHarness = (overrides?: {
  readonly path?: string;
  readonly reachability?:
    | VoiceEnvironmentReachability
    | ((id: string) => VoiceEnvironmentReachability);
  readonly redirectWatchMs?: number;
}): DriverHarness & { readonly deps: VoiceNavigatorDeps } => {
  const harness: DriverHarness = {
    driver: undefined as never,
    order: [],
    navigations: [],
    pending: [],
    path: overrides?.path ?? "/",
    pathListeners: [],
    marks: [],
    lateRedirects: [],
  };
  const reachabilityOf = overrides?.reachability;
  const reachability: (id: string) => VoiceEnvironmentReachability =
    typeof reachabilityOf === "function"
      ? reachabilityOf
      : (_id: string): VoiceEnvironmentReachability => reachabilityOf ?? "connected";
  let resolveIndex = 0;
  harness.driver = {
    navigate: async (input) => {
      harness.navigations.push({
        to: input.to,
        params: input.params,
        replace: input.replace,
      });
      harness.order.push(`navigate:${input.params.threadId}`);
      await new Promise<void>((resolve) => {
        harness.pending.push(() => {
          harness.order.push(`resolve:${input.params.threadId}`);
          resolve();
        });
        resolveIndex += 1;
      });
    },
    readCurrentPath: () => {
      harness.order.push(`read:${harness.path}`);
      return harness.path;
    },
    subscribePathChange: (listener) => {
      harness.pathListeners.push(listener);
      return () => {
        const index = harness.pathListeners.indexOf(listener);
        if (index >= 0) {
          harness.pathListeners.splice(index, 1);
        }
      };
    },
  };
  const deps: VoiceNavigatorDeps = {
    driver: harness.driver,
    reachabilityOf: reachability,
    emitMark: (mark, detail) => {
      harness.order.push(`mark:${mark}`);
      harness.marks.push({ mark, ...(detail === undefined ? {} : { detail }) });
    },
    onRedirectAfterAcknowledgment: (error) => {
      harness.lateRedirects.push(error);
    },
    ...(overrides?.redirectWatchMs !== undefined
      ? { redirectWatchMs: overrides.redirectWatchMs }
      : {}),
  };
  // Same reference with deps attached, so test mutations of harness.path are
  // visible to the driver closures.
  const result = harness as DriverHarness & { readonly deps: VoiceNavigatorDeps };
  Object.defineProperty(result, "deps", { value: deps, enumerable: true });
  return result;
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("voice navigator", () => {
  it("navigates to the thread route with the destination params and replace", async () => {
    const harness = makeHarness({ path: expectedThreadRoutePath(DESTINATION) });
    const navigator = createVoiceNavigator(harness.deps);

    const pending = navigator.navigateToThread(DESTINATION);
    harness.pending[0]?.();
    const result = await pending;

    expect(result).toEqual({ status: "acknowledged", destination: DESTINATION });
    expect(harness.navigations).toHaveLength(1);
    expect(harness.navigations[0]?.to).toBe(THREAD_ROUTE_TO);
    expect(harness.navigations[0]?.params).toEqual(DESTINATION);
    expect(harness.navigations[0]?.replace).toBe(true);
  });

  it("emits navigation_acknowledged only after the route read-back resolves", async () => {
    const harness = makeHarness({ path: expectedThreadRoutePath(DESTINATION) });
    const navigator = createVoiceNavigator(harness.deps);

    const pending = navigator.navigateToThread(DESTINATION);
    // Navigate resolved but read-back has not happened yet: no mark.
    harness.pending[0]?.();
    await pending;

    expect(harness.order).toEqual([
      "navigate:thread-1",
      "resolve:thread-1",
      "read:/env-1/thread-1",
      "mark:navigation_acknowledged",
    ]);
    expect(harness.marks).toHaveLength(1);
    expect(harness.marks[0]?.mark).toBe("navigation_acknowledged");
    expect(harness.marks[0]?.detail).toBe("env-1/thread-1");
  });

  it("reports a missing-thread redirect to / as a thread_not_found failure and never acknowledges", async () => {
    const harness = makeHarness({ path: "/" });
    const navigator = createVoiceNavigator(harness.deps);

    const pending = navigator.navigateToThread(DESTINATION);
    harness.pending[0]?.();
    const result = await pending;

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("thread_not_found");
      expect(result.error.threadId).toBe(DESTINATION.threadId);
    }
    expect(harness.marks).toHaveLength(0);
  });

  it("reports an unexpected landing path as a failed navigation", async () => {
    const harness = makeHarness({ path: "/some/other/route" });
    const navigator = createVoiceNavigator(harness.deps);

    const pending = navigator.navigateToThread(DESTINATION);
    harness.pending[0]?.();
    const result = await pending;

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("invalid_request");
    }
    expect(harness.marks).toHaveLength(0);
  });

  it("refuses an environment that is not in the catalog without navigating", async () => {
    const harness = makeHarness({ reachability: "unknown" });
    const navigator = createVoiceNavigator(harness.deps);

    const result = await navigator.navigateToThread(DESTINATION);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("environment_not_in_catalog");
    }
    expect(harness.navigations).toHaveLength(0);
    expect(harness.marks).toHaveLength(0);
  });

  it("refuses a disconnected environment without navigating", async () => {
    const harness = makeHarness({ reachability: "disconnected" });
    const navigator = createVoiceNavigator(harness.deps);

    const result = await navigator.navigateToThread(DESTINATION);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("environment_unreachable");
    }
    expect(harness.navigations).toHaveLength(0);
    expect(harness.marks).toHaveLength(0);
  });

  it("suppresses a superseded navigation: the older request resolves without marks", async () => {
    const harness = makeHarness({ path: expectedThreadRoutePath(OTHER_DESTINATION) });
    const navigator = createVoiceNavigator(harness.deps);

    const first = navigator.navigateToThread(DESTINATION);
    const second = navigator.navigateToThread(OTHER_DESTINATION);

    // Resolve the first (now-superseded) navigation: it must not read back,
    // acknowledge, or emit anything.
    harness.pending[0]?.();
    expect(await first).toEqual({ status: "superseded" });

    harness.pending[1]?.();
    const secondResult = await second;
    expect(secondResult).toEqual({ status: "acknowledged", destination: OTHER_DESTINATION });
    expect(harness.marks).toEqual([{ mark: "navigation_acknowledged", detail: "env-1/thread-2" }]);
    expect(harness.order).toEqual([
      "navigate:thread-1",
      "navigate:thread-2",
      "resolve:thread-1",
      "resolve:thread-2",
      "read:/env-1/thread-2",
      "mark:navigation_acknowledged",
    ]);
  });

  it("arms first_useful_speech on acknowledgment and fires it once on the first output delta", async () => {
    const harness = makeHarness({ path: expectedThreadRoutePath(DESTINATION) });
    const navigator = createVoiceNavigator(harness.deps);

    // Before any navigation: no mark.
    navigator.onOutputTranscriptDelta();
    expect(harness.marks).toHaveLength(0);

    const pending = navigator.navigateToThread(DESTINATION);
    harness.pending[0]?.();
    await pending;

    navigator.onOutputTranscriptDelta();
    navigator.onOutputTranscriptDelta();

    expect(harness.marks.map((record) => record.mark)).toEqual([
      "navigation_acknowledged",
      "first_useful_speech",
    ]);
  });

  it("reports a late redirect after acknowledgment as a failure callback", async () => {
    const harness = makeHarness({
      path: expectedThreadRoutePath(DESTINATION),
      redirectWatchMs: 30_000,
    });
    const navigator = createVoiceNavigator(harness.deps);

    const pending = navigator.navigateToThread(DESTINATION);
    harness.pending[0]?.();
    await pending;

    expect(harness.pathListeners).toHaveLength(1);
    harness.pathListeners[0]?.("/");
    harness.pathListeners[0]?.("/");
    await flush();

    expect(harness.lateRedirects).toHaveLength(1);
    expect(harness.lateRedirects[0]?.code).toBe("thread_not_found");
    // The watch unsubscribes after firing.
    expect(harness.pathListeners).toHaveLength(0);
  });

  it("ignores path changes for a navigation that is no longer current", async () => {
    const harness = makeHarness({
      path: expectedThreadRoutePath(DESTINATION),
      redirectWatchMs: 30_000,
    });
    const navigator = createVoiceNavigator(harness.deps);

    const first = navigator.navigateToThread(DESTINATION);
    harness.pending[0]?.();
    await first;

    // A newer navigation supersedes the armed watch of the first.
    const second = navigator.navigateToThread(OTHER_DESTINATION);
    harness.path = expectedThreadRoutePath(OTHER_DESTINATION);
    harness.pending[1]?.();
    const secondResult = await second;
    expect(secondResult.status).toBe("acknowledged");
    expect(harness.pathListeners).toHaveLength(1);

    // Starting the second navigation cleared the first watch, so the single
    // remaining listener belongs to the current navigation. A redirect must
    // be attributed to the acknowledged destination (thread-2), never the
    // superseded one (thread-1).
    harness.pathListeners[0]?.("/");
    await flush();
    expect(harness.lateRedirects).toHaveLength(1);
    expect(harness.lateRedirects[0]?.code).toBe("thread_not_found");
    expect(harness.lateRedirects[0]?.threadId).toBe(OTHER_DESTINATION.threadId);
  });

  it("stops the redirect watch on dispose", async () => {
    const harness = makeHarness({
      path: expectedThreadRoutePath(DESTINATION),
      redirectWatchMs: 30_000,
    });
    const navigator = createVoiceNavigator(harness.deps);

    const pending = navigator.navigateToThread(DESTINATION);
    harness.pending[0]?.();
    await pending;
    expect(harness.pathListeners).toHaveLength(1);

    navigator.dispose();
    expect(harness.pathListeners).toHaveLength(0);

    harness.pathListeners[0]?.("/");
    await flush();
    expect(harness.lateRedirects).toHaveLength(0);
  });
});
