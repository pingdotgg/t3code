import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  activateCloudRelayAccount,
  deactivateCloudRelayAccount,
  releaseCloudRelayUiAccount,
} from "./CloudAuthProvider";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";
import { acquireBackgroundManagedRelaySession } from "./managedRelaySessionOwnership";

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

  it("preserves the background session when the UI bridge unmounts", () => {
    const releaseBackground = acquireBackgroundManagedRelaySession({
      accountId: "account-1",
      readClerkToken: async () => "background-token",
    });
    activateCloudRelayAccount("account-1", async () => "ui-token");

    releaseCloudRelayUiAccount();

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    releaseBackground?.();
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
  });
});
