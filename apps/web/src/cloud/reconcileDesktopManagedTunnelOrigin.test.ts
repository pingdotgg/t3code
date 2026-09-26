import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_MANAGED_TUNNEL_ORIGIN_RECONCILE_MAX_ATTEMPTS,
  desktopManagedTunnelOriginReconcileKey,
  desktopManagedTunnelOriginReconcileRetryDelayMs,
  startDesktopManagedTunnelOriginReconcile,
} from "./reconcileDesktopManagedTunnelOrigin";
import type { CloudLinkTarget } from "./linkEnvironment";

const TARGET: CloudLinkTarget = {
  environmentId: "environment-1",
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3774",
  wsBaseUrl: "ws://127.0.0.1:3774",
};

describe("desktopManagedTunnelOriginReconcileKey", () => {
  it("keys a signed-in managed loopback link so a later port hop re-registers", () => {
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: true,
        target: TARGET,
        linked: true,
        managedTunnelActive: true,
      }),
    ).toBe("environment-1:http://127.0.0.1:3774");
  });

  it("skips when the session is signed out or the environment is not linked", () => {
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: false,
        target: TARGET,
        linked: true,
        managedTunnelActive: true,
      }),
    ).toBeNull();
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: true,
        target: TARGET,
        linked: false,
        managedTunnelActive: false,
      }),
    ).toBeNull();
  });

  it("skips publish-only links that have no managed tunnel origin", () => {
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: true,
        target: TARGET,
        linked: true,
        managedTunnelActive: false,
      }),
    ).toBeNull();
  });

  it("skips non-loopback primary origins so a remote client cannot rewrite ingress", () => {
    expect(
      desktopManagedTunnelOriginReconcileKey({
        signedIn: true,
        target: {
          ...TARGET,
          httpBaseUrl: "https://prod-example.t3coderelay.com/",
          wsBaseUrl: "wss://prod-example.t3coderelay.com/",
        },
        linked: true,
        managedTunnelActive: true,
      }),
    ).toBeNull();
  });
});

describe("desktopManagedTunnelOriginReconcileRetryDelayMs", () => {
  it("backs off after each failed attempt and stops at the bound", () => {
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(1)).toBe(1_000);
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(2)).toBe(2_000);
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(3)).toBe(4_000);
    expect(
      desktopManagedTunnelOriginReconcileRetryDelayMs(
        DESKTOP_MANAGED_TUNNEL_ORIGIN_RECONCILE_MAX_ATTEMPTS,
      ),
    ).toBeNull();
  });

  it("does not schedule a retry for a non-attempt", () => {
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(0)).toBeNull();
    expect(desktopManagedTunnelOriginReconcileRetryDelayMs(1.5)).toBeNull();
  });
});

describe("startDesktopManagedTunnelOriginReconcile", () => {
  /** Controllable timers and attempt resolvers for reconcile retry tests. */
  function createHarness() {
    type AttemptResult = "success" | "failure";
    const resolvers: Array<(result: AttemptResult) => void> = [];
    const timers = new Map<number, { handler: () => void; delayMs: number; cancelled: boolean }>();
    let nextTimerId = 1;

    const cancel = startDesktopManagedTunnelOriginReconcile({
      runAttempt: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
      setTimeoutFn: (handler, delayMs) => {
        const id = nextTimerId++;
        timers.set(id, { handler, delayMs, cancelled: false });
        return id;
      },
      clearTimeoutFn: (id) => {
        const timer = timers.get(id as number);
        if (timer) timer.cancelled = true;
      },
    });

    /** Delay values for timers that have not been cleared. */
    const pendingDelays = () =>
      [...timers.values()].filter((timer) => !timer.cancelled).map((timer) => timer.delayMs);

    /** Resolves the latest pending attempt and flushes microtasks. */
    const resolveLatest = async (result: AttemptResult) => {
      const resolve = resolvers.at(-1);
      expect(resolve).toBeDefined();
      resolve?.(result);
      await Promise.resolve();
    };

    /** Fires the next uncleared timer callback and flushes microtasks. */
    const fireNextTimer = async () => {
      const timer = [...timers.values()].find((entry) => !entry.cancelled);
      expect(timer).toBeDefined();
      if (!timer) return;
      timer.cancelled = true;
      timer.handler();
      await Promise.resolve();
    };

    return {
      cancel,
      pendingDelays,
      resolveLatest,
      fireNextTimer,
      /** Number of attempt promises created so far. */
      attemptCount: () => resolvers.length,
    };
  }

  it("retries failed attempts with backoff until the bound", async () => {
    const harness = createHarness();

    expect(harness.attemptCount()).toBe(1);
    await harness.resolveLatest("failure");
    expect(harness.pendingDelays()).toEqual([desktopManagedTunnelOriginReconcileRetryDelayMs(1)]);

    await harness.fireNextTimer();
    expect(harness.attemptCount()).toBe(2);
    await harness.resolveLatest("failure");
    expect(harness.pendingDelays()).toEqual([desktopManagedTunnelOriginReconcileRetryDelayMs(2)]);

    await harness.fireNextTimer();
    expect(harness.attemptCount()).toBe(3);
    await harness.resolveLatest("failure");
    expect(harness.pendingDelays()).toEqual([desktopManagedTunnelOriginReconcileRetryDelayMs(3)]);

    await harness.fireNextTimer();
    expect(harness.attemptCount()).toBe(4);
    await harness.resolveLatest("failure");
    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.attemptCount()).toBe(DESKTOP_MANAGED_TUNNEL_ORIGIN_RECONCILE_MAX_ATTEMPTS);
  });

  it("stops scheduling after a successful attempt", async () => {
    const harness = createHarness();

    await harness.resolveLatest("failure");
    await harness.fireNextTimer();
    await harness.resolveLatest("success");

    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.attemptCount()).toBe(2);
  });

  it("cancels a pending retry so unmount does not re-register", async () => {
    const harness = createHarness();

    await harness.resolveLatest("failure");
    expect(harness.pendingDelays()).toEqual([1_000]);
    harness.cancel();
    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.attemptCount()).toBe(1);
  });

  it("ignores a late failure after cancel", async () => {
    const harness = createHarness();
    harness.cancel();
    await harness.resolveLatest("failure");
    expect(harness.pendingDelays()).toEqual([]);
    expect(harness.attemptCount()).toBe(1);
  });
});
