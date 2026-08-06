import { describe, expect, it, vi } from "vite-plus/test";

import {
  bootstrapBackgroundManagedRelayAuth,
  invalidateBackgroundManagedRelayAuth,
  refreshBackgroundManagedRelayAuth,
  startBackgroundManagedRelayAuth,
} from "./backgroundManagedRelayAuth";

vi.mock("@clerk/expo", () => ({ getClerkInstance: vi.fn() }));
vi.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

const configuredPublicConfig = {
  clerk: {
    publishableKey: "pk_test_example",
    jwtTemplate: "relay-template",
  },
  relay: { url: "https://relay.example.com/" },
  observability: {
    tracesUrl: null,
    tracesDataset: null,
    tracesToken: null,
  },
} as const;

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("background managed relay authentication", () => {
  it("loads Clerk and acquires a renewable session for the active account", async () => {
    const load = vi.fn(async () => undefined);
    const getToken = vi.fn(async () => "relay-token");
    const release = vi.fn();
    const acquireSession = vi.fn(
      (_session: {
        readonly accountId: string;
        readonly readClerkToken: () => Promise<string | null>;
      }) => release,
    );
    const resolveTokenOptions = vi.fn(() => ({
      template: "relay-template",
      skipCache: true as const,
    }));

    const result = await bootstrapBackgroundManagedRelayAuth({
      resolveConfig: () => configuredPublicConfig,
      createClerk: () => ({
        loaded: false,
        load,
        session: { user: { id: "account-1" }, getToken },
      }),
      resolveTokenOptions,
      acquireSession,
    });

    expect(result.state).toEqual({ status: "active", accountId: "account-1" });
    expect(load).toHaveBeenCalledOnce();
    const session = acquireSession.mock.calls[0]?.[0];
    expect(session?.accountId).toBe("account-1");
    await expect(session?.readClerkToken()).resolves.toBe("relay-token");
    expect(getToken).toHaveBeenCalledWith({
      template: "relay-template",
      skipCache: true,
    });
  });

  it("treats a loaded Clerk instance without a session as signed out", async () => {
    const acquireSession = vi.fn(
      (_session: {
        readonly accountId: string;
        readonly readClerkToken: () => Promise<string | null>;
      }) => vi.fn(),
    );

    const result = await bootstrapBackgroundManagedRelayAuth({
      resolveConfig: () => configuredPublicConfig,
      createClerk: () => ({ loaded: true, load: vi.fn(), session: null }),
      resolveTokenOptions: vi.fn(() => ({
        template: "relay-template",
        skipCache: true as const,
      })),
      acquireSession,
    });

    expect(result.state).toEqual({ status: "signed-out" });
    expect(acquireSession).not.toHaveBeenCalled();
  });

  it("does not report active when a stale background owner is rejected", async () => {
    const result = await bootstrapBackgroundManagedRelayAuth({
      resolveConfig: () => configuredPublicConfig,
      createClerk: () => ({
        loaded: true,
        load: vi.fn(),
        session: {
          user: { id: "stale-account" },
          getToken: vi.fn(async () => "stale-token"),
        },
      }),
      resolveTokenOptions: vi.fn(() => ({
        template: "relay-template",
        skipCache: true as const,
      })),
      acquireSession: vi.fn(() => null),
    });

    expect(result).toEqual({ state: { status: "superseded" } });
  });

  it("returns immediately for missing public configuration", async () => {
    const createClerk = vi.fn();
    const result = await bootstrapBackgroundManagedRelayAuth({
      resolveConfig: () => ({
        ...configuredPublicConfig,
        clerk: { publishableKey: null, jwtTemplate: null },
      }),
      createClerk,
      resolveTokenOptions: vi.fn(() => ({
        template: "relay-template",
        skipCache: true as const,
      })),
      acquireSession: vi.fn(
        (_session: {
          readonly accountId: string;
          readonly readClerkToken: () => Promise<string | null>;
        }) => vi.fn(),
      ),
    });

    expect(result.state).toEqual({ status: "unconfigured" });
    expect(createClerk).not.toHaveBeenCalled();
  });

  it("reports transient Clerk initialization failures without throwing", async () => {
    const error = new Error("Network unavailable");
    const result = await bootstrapBackgroundManagedRelayAuth({
      resolveConfig: () => configuredPublicConfig,
      createClerk: () => {
        throw error;
      },
      resolveTokenOptions: vi.fn(() => ({
        template: "relay-template",
        skipCache: true as const,
      })),
      acquireSession: vi.fn(
        (_session: {
          readonly accountId: string;
          readonly readClerkToken: () => Promise<string | null>;
        }) => vi.fn(),
      ),
    });

    expect(result.state).toEqual({ status: "retrying", error });
  });

  it("cannot restore a stale account after sign-out invalidates an in-flight load", async () => {
    const load = deferred<void>();
    const acquireSession = vi.fn(() => vi.fn());
    const attempt = bootstrapBackgroundManagedRelayAuth({
      resolveConfig: () => configuredPublicConfig,
      createClerk: () => ({
        loaded: false,
        load: () => load.promise,
        session: {
          user: { id: "old-account" },
          getToken: vi.fn(async () => "old-token"),
        },
      }),
      resolveTokenOptions: vi.fn(() => ({
        template: "relay-template",
        skipCache: true as const,
      })),
      acquireSession,
    });

    invalidateBackgroundManagedRelayAuth();
    load.resolve();

    await expect(attempt).resolves.toEqual({ state: { status: "superseded" } });
    expect(acquireSession).not.toHaveBeenCalled();
  });

  it("keeps the controller alive and retries transient Clerk failures", async () => {
    const error = new Error("Clerk is temporarily unavailable");
    const release = vi.fn();
    const bootstrap = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        state: { status: "active", accountId: "account-1" },
        release,
      });
    const scheduledRetries: Array<{ retry: () => void; delayMs: number }> = [];
    const controller = startBackgroundManagedRelayAuth({
      bootstrap,
      scheduleRetry: (retry, delayMs) => {
        scheduledRetries.push({ retry, delayMs });
        return vi.fn();
      },
    });

    await expect(controller.firstAttempt).resolves.toEqual({ status: "retrying", error });
    expect(scheduledRetries).toHaveLength(1);
    expect(scheduledRetries[0]?.delayMs).toBe(1_000);
    await expect(controller.retryNow()).resolves.toEqual({
      status: "active",
      accountId: "account-1",
    });

    controller.stop();
    expect(release).toHaveBeenCalledOnce();
  });

  it("retries a signed-out bootstrap when UI ownership changes", async () => {
    const release = vi.fn();
    const bootstrap = vi
      .fn()
      .mockResolvedValueOnce({ state: { status: "signed-out" } })
      .mockResolvedValueOnce({
        state: { status: "active", accountId: "account-1" },
        release,
      });
    const controller = startBackgroundManagedRelayAuth({ bootstrap });
    await expect(controller.firstAttempt).resolves.toEqual({ status: "signed-out" });

    await refreshBackgroundManagedRelayAuth();

    expect(bootstrap).toHaveBeenCalledTimes(2);
    controller.stop();
    expect(release).toHaveBeenCalledOnce();
  });

  it("queues a fresh bootstrap when refresh is requested during an in-flight attempt", async () => {
    const first = deferred<{ state: { status: "superseded" } }>();
    const bootstrap = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ state: { status: "signed-out" } });
    const controller = startBackgroundManagedRelayAuth({ bootstrap });

    const refreshed = controller.retryNow();
    expect(bootstrap).toHaveBeenCalledOnce();
    first.resolve({ state: { status: "superseded" } });

    await expect(refreshed).resolves.toEqual({ status: "signed-out" });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("stops retrying and releases ownership idempotently", async () => {
    const release = vi.fn();
    const controller = startBackgroundManagedRelayAuth({
      bootstrap: async () => ({
        state: { status: "active", accountId: "account-1" },
        release,
      }),
    });
    await controller.firstAttempt;

    controller.stop();
    controller.stop();
    expect(release).toHaveBeenCalledOnce();
  });
});
