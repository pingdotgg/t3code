import { managedRelaySessionAtom, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/reactivity";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
  ManagedRelayAuthProvider,
} from "./managedAuth";

const testState = vi.hoisted(() => ({
  auth: { isLoaded: false, isSignedIn: false, userId: null as string | null },
  getToken: async () => "token",
  removeRelayEnvironments: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ ...testState.auth, getToken: testState.getToken }),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => testState.removeRelayEnvironments,
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(async () => Exit.void),
  },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  testState.auth = { isLoaded: false, isSignedIn: false, userId: null };
  testState.removeRelayEnvironments.mockReset();
  deactivateManagedRelayAuthentication();
});

async function renderAuth(auth: typeof testState.auth) {
  testState.auth = auth;
  testState.removeRelayEnvironments.mockResolvedValue(AsyncResult.success(undefined));
  const element = createElement(ManagedRelayAuthProvider, null, null);
  await act(async () => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = create(element);
    }
  });
}

const signedOut = { isLoaded: true, isSignedIn: false, userId: null };
const signedInAs = (userId: string) => ({ isLoaded: true, isSignedIn: true, userId });

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

describe("ManagedRelayAuthProvider account cleanup", () => {
  it("keeps relay environments when the first loaded state is signed out", async () => {
    await renderAuth({ isLoaded: false, isSignedIn: false, userId: null });
    await renderAuth(signedOut);

    expect(testState.removeRelayEnvironments).not.toHaveBeenCalled();
  });

  it("removes relay environments when a signed-in account signs out", async () => {
    await renderAuth(signedInAs("account-1"));
    await renderAuth(signedOut);

    expect(testState.removeRelayEnvironments).toHaveBeenCalledTimes(1);
  });

  it("removes relay environments when the account changes", async () => {
    await renderAuth(signedInAs("account-1"));
    await renderAuth(signedInAs("account-2"));

    expect(testState.removeRelayEnvironments).toHaveBeenCalledTimes(1);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
  });
});
