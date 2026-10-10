import { managedRelaySessionAtom, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { act, createElement, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  ManagedAccountContext,
  type ConnectOnboardingRequest,
  type ManagedAccountState,
  useConnectOnboardingRequest,
} from "./connectOnboarding";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
} from "./managedAuth";

vi.mock("@clerk/react", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

afterEach(() => {
  deactivateManagedRelayAuthentication();
});

describe("managed relay authentication", () => {
  it("clears all token access synchronously before account cleanup can fail", async () => {
    activateManagedRelayAuthentication("account-1", async () => "account-1-token");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    const token = await Effect.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)).pipe(
      Effect.flatMap((session) => session.readClerkToken()),
      Effect.runPromise,
    );
    expect(token).toBe("account-1-token");

    deactivateManagedRelayAuthentication();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    await cleanup;
  });

  it("replaces an existing account session atomically", () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-1",
      readClerkToken: async () => "account-1-token",
    });

    activateManagedRelayAuthentication("account-2", async () => "account-2-token");

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
  });
});

describe("connect onboarding sign-in requests", () => {
  let renderer: ReactTestRenderer | null = null;
  let request: ConnectOnboardingRequest | null = null;

  function RequestProbe() {
    const value = useConnectOnboardingRequest();
    useLayoutEffect(() => {
      request = value;
    });
    return null;
  }

  const render = (account: ManagedAccountState) =>
    act(() => {
      const tree = createElement(
        ManagedAccountContext,
        { value: account },
        createElement(RequestProbe),
      );
      if (renderer === null) renderer = create(tree);
      else renderer.update(tree);
    });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = null;
    request = null;
    vi.unstubAllGlobals();
  });

  it("does not request the wizard for a restored session", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await render({ isLoaded: false, isSignedIn: undefined, userId: undefined });
    await render({ isLoaded: true, isSignedIn: true, userId: null });
    await render({ isLoaded: true, isSignedIn: true, userId: "account-1" });

    expect(request?.requestedAccount).toBeNull();
  });

  // The wizard chunk loads lazily, so the request waits until it is taken.
  it("holds each in-session sign-in until the wizard takes it", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await render({ isLoaded: true, isSignedIn: false, userId: null });
    await render({ isLoaded: true, isSignedIn: true, userId: "account-1" });
    await render({ isLoaded: true, isSignedIn: true, userId: "account-1" });
    expect(request?.requestedAccount).toBe("account-1");

    await act(() => request?.clearRequestedAccount());
    expect(request?.requestedAccount).toBeNull();

    await render({ isLoaded: true, isSignedIn: true, userId: "account-2" });
    expect(request?.requestedAccount).toBe("account-2");
  });
});
