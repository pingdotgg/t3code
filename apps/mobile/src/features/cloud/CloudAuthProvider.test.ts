import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";
import {
  activateCloudRelayAccount,
  deactivateCloudRelayAccount,
  releaseCloudRelayUiAccount,
} from "./CloudAuthProvider";
import {
  invalidateBackgroundManagedRelayAuth,
  refreshBackgroundManagedRelayAuth,
} from "./backgroundManagedRelayAuth";
import { acquireBackgroundManagedRelaySession } from "./managedRelaySessionOwnership";

vi.mock("@clerk/expo", () => ({
  ClerkProvider: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

vi.mock("./backgroundManagedRelayAuth", () => ({
  invalidateBackgroundManagedRelayAuth: vi.fn(),
  refreshBackgroundManagedRelayAuth: vi.fn(async () => undefined),
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./publicConfig", () => ({
  resolveCloudPublicConfig: vi.fn(() => ({
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  resolveRelayClerkTokenOptions: vi.fn(),
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  releaseAgentAwarenessRelayTokenProvider: vi.fn(),
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("clears relay and agent-awareness credentials before cleanup can fail", async () => {
    const tokenProvider = async () => "account-1-token";
    activateCloudRelayAccount("account-1", tokenProvider);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    expect(refreshBackgroundManagedRelayAuth).toHaveBeenCalledOnce();

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    expect(invalidateBackgroundManagedRelayAuth).toHaveBeenCalledOnce();
    await cleanup;
  });

  it("preserves background relay ownership when the UI bridge unmounts", () => {
    const releaseBackground = acquireBackgroundManagedRelaySession({
      accountId: "account-1",
      readClerkToken: async () => "background-token",
    });
    activateCloudRelayAccount("account-1", async () => "ui-token");
    vi.mocked(refreshBackgroundManagedRelayAuth).mockClear();

    releaseCloudRelayUiAccount();

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    expect(refreshBackgroundManagedRelayAuth).toHaveBeenCalledOnce();
    expect(releaseBackground).not.toBeNull();
    releaseBackground?.();
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
  });

  it("waits for account cleanup before refreshing background ownership", async () => {
    activateCloudRelayAccount("account-1", async () => "ui-token");
    vi.mocked(refreshBackgroundManagedRelayAuth).mockClear();
    const cleanup = deferred();

    releaseCloudRelayUiAccount({ refreshAfter: cleanup.promise });

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(refreshBackgroundManagedRelayAuth).not.toHaveBeenCalled();

    cleanup.resolve();
    await cleanup.promise;
    await Promise.resolve();

    expect(refreshBackgroundManagedRelayAuth).toHaveBeenCalledOnce();
  });

  it("defers the background refresh for an account switch until cleanup resolves", async () => {
    activateCloudRelayAccount("account-1", async () => "account-1-token");
    vi.mocked(refreshBackgroundManagedRelayAuth).mockClear();

    const cleanup = deferred();
    deactivateCloudRelayAccount({ refreshBackground: false });
    const transition = cleanup.promise.then(() => {
      activateCloudRelayAccount("account-2", async () => "account-2-token");
    });

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(invalidateBackgroundManagedRelayAuth).toHaveBeenCalledOnce();
    expect(refreshBackgroundManagedRelayAuth).not.toHaveBeenCalled();

    cleanup.resolve();
    await transition;

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
    expect(refreshBackgroundManagedRelayAuth).toHaveBeenCalledOnce();
  });
});
