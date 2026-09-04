import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentId,
  type EnvironmentCloudLinkStateResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  scopes: new Set<string>(),
  snapshot: null as EnvironmentCloudLinkStateResult | null,
  renderedSnapshot: null as EnvironmentCloudLinkStateResult | null,
  getToken: vi.fn<() => Promise<string | null>>(),
  link: vi.fn(),
  unlink: vi.fn(),
  preferences: vi.fn(),
  refreshDiscovery: vi.fn(),
  refreshLink: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken: testState.getToken, isSignedIn: true }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: testState.toast } }));
vi.mock("../state/relay", () => ({
  relayEnvironmentDiscovery: { refresh: testState.refreshDiscovery },
}));
vi.mock("../state/session", () => ({
  readEnvironmentScope: (_environmentId: string, scope: string) => testState.scopes.has(scope),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./linkEnvironmentAtoms", () => ({
  linkPrimaryEnvironment: testState.link,
  unlinkPrimaryEnvironment: testState.unlink,
  updatePrimaryEnvironmentPreferences: testState.preferences,
}));
vi.mock("./primaryCloudLinkState", () => ({
  readCachedPrimaryCloudLinkState: () => testState.snapshot,
  usePrimaryCloudLinkState: () => ({
    target,
    data: testState.renderedSnapshot,
    error: null,
    isPending: false,
    refresh: testState.refreshLink,
  }),
}));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));

import { useCloudLinkController, type CloudLinkDesiredState } from "./useCloudLinkController";

const target = {
  environmentId: EnvironmentId.make("primary"),
  label: "Primary",
  httpBaseUrl: "http://localhost:3773",
  wsBaseUrl: "ws://localhost:3773/ws",
};
const linkedState: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "account-1",
  relayUrl: "https://relay.example.com",
  relayIssuer: "https://relay.example.com",
  managedTunnelActive: true,
  publishAgentActivity: false,
};

let renderer: ReactTestRenderer | null = null;
let controller: ReturnType<typeof useCloudLinkController> | null = null;

function ControllerProbe() {
  const value = useCloudLinkController();
  useLayoutEffect(() => {
    controller = value;
  });
  return null;
}

async function mountController() {
  await act(() => {
    renderer = create(<ControllerProbe />);
  });
}

async function reconcile(desired: CloudLinkDesiredState) {
  let succeeded = false;
  await act(async () => {
    if (controller === null) throw new Error("Controller is not mounted.");
    succeeded = await controller.reconcileCloudState(desired);
  });
  return succeeded;
}

function expectNoMutations() {
  expect(testState.link).not.toHaveBeenCalled();
  expect(testState.unlink).not.toHaveBeenCalled();
  expect(testState.preferences).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  testState.scopes = new Set([AuthRelayReadScope, AuthRelayWriteScope]);
  testState.snapshot = linkedState;
  testState.renderedSnapshot = linkedState;
  testState.getToken.mockReset().mockResolvedValue("clerk-token");
  for (const command of [
    testState.link,
    testState.unlink,
    testState.preferences,
    testState.refreshDiscovery,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success({}));
  }
  testState.refreshLink.mockReset();
  testState.toast.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  controller = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCloudLinkController", () => {
  it.each([AuthRelayReadScope, AuthRelayWriteScope])(
    "does not mutate without %s, even with a cached link snapshot",
    async (scope) => {
      await mountController();
      testState.scopes.delete(scope);

      expect(await reconcile({ managedTunnel: true, publish: true })).toBe(false);
      expect(testState.getToken).not.toHaveBeenCalled();
      expectNoMutations();
    },
  );

  it("does not interpret unavailable link state as an unlinked environment", async () => {
    testState.snapshot = null;
    await mountController();

    expect(await reconcile({ managedTunnel: false, publish: true })).toBe(false);
    expect(testState.getToken).not.toHaveBeenCalled();
    expectNoMutations();
  });

  it.each([AuthRelayReadScope, AuthRelayWriteScope])(
    "rechecks %s after requesting the cloud token",
    async (scope) => {
      await mountController();
      testState.getToken.mockImplementationOnce(async () => {
        testState.scopes.delete(scope);
        return "clerk-token";
      });

      expect(await reconcile({ managedTunnel: false, publish: false })).toBe(false);
      expectNoMutations();
    },
  );

  it("stops if the link-state read fails while requesting the cloud token", async () => {
    await mountController();
    testState.getToken.mockImplementationOnce(async () => {
      testState.snapshot = null;
      return "clerk-token";
    });

    expect(await reconcile({ managedTunnel: true, publish: true })).toBe(false);
    expectNoMutations();
  });

  it("uses the latest linked mode to change publishing without replacing the tunnel", async () => {
    testState.snapshot = { ...linkedState, linked: false, managedTunnelActive: false };
    testState.renderedSnapshot = testState.snapshot;
    await mountController();
    testState.getToken.mockImplementationOnce(async () => {
      testState.snapshot = linkedState;
      return "clerk-token";
    });

    expect(await reconcile({ managedTunnel: true, publish: true })).toBe(true);
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.unlink).not.toHaveBeenCalled();
    expect(testState.preferences).toHaveBeenCalledExactlyOnceWith({
      target,
      publishAgentActivity: true,
    });
  });

  it("stops the preference write if management permission is lost after linking", async () => {
    await mountController();
    testState.link.mockImplementationOnce(async () => {
      testState.scopes.delete(AuthRelayWriteScope);
      return AsyncResult.success({});
    });

    expect(await reconcile({ managedTunnel: false, publish: true })).toBe(false);
    expect(testState.link).toHaveBeenCalledOnce();
    expect(testState.preferences).not.toHaveBeenCalled();
    expect(testState.refreshLink).toHaveBeenCalledOnce();
  });

  it("still lets an authorized user unlink when the cloud token is unavailable", async () => {
    await mountController();
    testState.getToken.mockRejectedValueOnce(new Error("Cloud sign-in unavailable"));

    expect(await reconcile({ managedTunnel: false, publish: false })).toBe(true);
    expect(testState.unlink).toHaveBeenCalledExactlyOnceWith({ target, clerkToken: null });
    expect(testState.link).not.toHaveBeenCalled();
    expect(testState.preferences).not.toHaveBeenCalled();
  });
});
