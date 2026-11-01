import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  activateCloudRelayAccount,
  cloudAccountService,
  deactivateCloudRelayAccount,
} from "./cloudAccountService";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";
import { requestConnectOnboarding } from "./connectOnboarding";
import { restoreCloudComposerDrafts } from "../../state/use-composer-drafts";

vi.mock("@clerk/expo", () => ({
  ClerkProvider: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
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

vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("./connectOnboarding", () => ({
  clearConnectOnboardingRequest: vi.fn(),
  requestConnectOnboarding: vi.fn(),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(async () => null),
  restoreCloudComposerDrafts: vi.fn(async () => undefined),
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

type ClerkListener = (resources: { readonly user: { readonly id: string } | null }) => void;

function fakeClerk() {
  const listeners = new Set<ClerkListener>();
  const clerk = {
    session: null,
    addListener: (listener: ClerkListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Parameters<typeof cloudAccountService.attach>[0];
  const emit = (userId: string | null) => {
    for (const listener of listeners) listener({ user: userId === null ? null : { id: userId } });
  };
  return { clerk, emit };
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

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    await cleanup;
  });
});

describe("cloudAccountService", () => {
  it("activates the signed-in account once its drafts are restored", async () => {
    const { clerk, emit } = fakeClerk();
    using _detach = { [Symbol.dispose]: cloudAccountService.attach(clerk) };

    emit("account-1");
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();

    await vi.waitFor(() =>
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1"),
    );
    expect(vi.mocked(restoreCloudComposerDrafts)).toHaveBeenCalledWith("account-1");
    // Clerk already had this account on its first emission, so this is not a fresh sign-in.
    expect(vi.mocked(requestConnectOnboarding)).not.toHaveBeenCalled();
  });

  it("retries an activation whose draft restore failed on the next emission", async () => {
    const { clerk, emit } = fakeClerk();
    using _detach = { [Symbol.dispose]: cloudAccountService.attach(clerk) };
    vi.mocked(restoreCloudComposerDrafts).mockRejectedValueOnce(new Error("Storage busy."));

    emit("account-1");
    await vi.waitFor(() => expect(cloudAccountService.getState()._tag).toBe("Failed"));
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();

    emit("account-1");
    await vi.waitFor(() =>
      expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1"),
    );
  });
});
