import type { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  preferences: vi.fn(),
  refresh: vi.fn(),
  refreshRelay: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ getToken: mocks.getToken, isSignedIn: true }),
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../state/relay", () => ({ relayEnvironmentDiscovery: { refresh: mocks.refreshRelay } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./linkEnvironmentAtoms", () => ({
  linkPrimaryEnvironment: mocks.link,
  unlinkPrimaryEnvironment: mocks.unlink,
  updatePrimaryEnvironmentPreferences: mocks.preferences,
}));
vi.mock("./primaryCloudLinkState", () => ({ usePrimaryCloudLinkState: () => linkState }));
vi.mock("../state/environments", () => ({ useRelayEnvironmentDiscovery: () => discovery }));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: () => ({}) }));

import { useCloudLinkController } from "./useCloudLinkController";

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  label: "Test environment",
  httpBaseUrl: "http://localhost:1234",
  wsBaseUrl: "ws://localhost:1234/ws",
};
const linkState = {
  target,
  data: { linked: true, managedTunnelActive: true, publishAgentActivity: true },
  refresh: mocks.refresh,
  error: null,
  isPending: false,
};
let discovery: Discovery.RelayEnvironmentDiscoveryState;
let renderer: ReactTestRenderer | undefined;
let controller: ReturnType<typeof useCloudLinkController>;

function Harness() {
  const current = useCloudLinkController();
  useLayoutEffect(() => {
    controller = current;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  linkState.data = { linked: true, managedTunnelActive: true, publishAgentActivity: true };
  discovery = {
    environments: new Map([
      [
        target.environmentId,
        {
          environment: {
            environmentId: target.environmentId,
            label: target.label,
            endpoint: {
              httpBaseUrl: target.httpBaseUrl,
              wsBaseUrl: target.wsBaseUrl,
              providerKind: "manual",
            },
            linkedAt: "2026-09-15T12:00:00.000Z",
          },
          availability: "online",
          status: Option.none(),
          error: Option.none(),
        },
      ],
    ]),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  mocks.getToken.mockResolvedValue("test-token");
  for (const command of [mocks.link, mocks.unlink, mocks.preferences, mocks.refreshRelay]) {
    command.mockResolvedValue(AsyncResult.success(undefined));
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("relinks a publish-only relay record even when local T3 Connect is already on", async () => {
  expect(controller.managedTunnelOutOfSync).toBe(true);
  await act(async () => {
    expect(await controller.reconcileCloudState({ managedTunnel: true, publish: true })).toBe(true);
  });
  expect(mocks.link).toHaveBeenCalledWith({ target, clerkToken: "test-token", mode: "managed" });
  expect(mocks.preferences).toHaveBeenCalledWith({ target, publishAgentActivity: true });
  expect(mocks.refreshRelay).toHaveBeenCalledOnce();
});

it("relinks when discovery temporarily clears the drifted record during refresh", async () => {
  discovery = { ...discovery, environments: new Map(), refreshing: true };
  await act(async () => renderer?.update(<Harness />));
  await act(async () => {
    expect(await controller.reconcileCloudState({ managedTunnel: true, publish: false })).toBe(
      true,
    );
  });
  expect(mocks.link).toHaveBeenCalledWith({ target, clerkToken: "test-token", mode: "managed" });
  expect(mocks.preferences).toHaveBeenCalledWith({ target, publishAgentActivity: false });
});

it.each(["healthy", "unknown"])(
  "keeps publish changes cheap when the relay mode is %s",
  async (state) => {
    discovery = {
      ...discovery,
      environments:
        state === "unknown"
          ? new Map()
          : new Map(
              [...discovery.environments].map(([id, entry]) => [
                id,
                {
                  ...entry,
                  environment: {
                    ...entry.environment,
                    endpoint: { ...entry.environment.endpoint, providerKind: "cloudflare_tunnel" },
                  },
                },
              ]),
            ),
    };
    await act(async () => renderer?.update(<Harness />));
    expect(controller.managedTunnelOutOfSync).toBe(false);
    await act(async () => {
      expect(await controller.reconcileCloudState({ managedTunnel: true, publish: false })).toBe(
        true,
      );
    });
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.preferences).toHaveBeenCalledWith({ target, publishAgentActivity: false });
  },
);

it("allows an explicit repair without discovery and preserves disabled publishing", async () => {
  discovery = { ...discovery, environments: new Map() };
  linkState.data.publishAgentActivity = false;
  await act(async () => renderer?.update(<Harness />));
  await act(async () => {
    expect(
      await controller.reconcileCloudState(
        { managedTunnel: true, publish: false },
        { forceRelink: true },
      ),
    ).toBe(true);
  });
  expect(mocks.link).toHaveBeenCalledWith({ target, clerkToken: "test-token", mode: "managed" });
  expect(mocks.preferences).toHaveBeenCalledWith({ target, publishAgentActivity: false });
});

it("keeps publishing on when disabling a managed tunnel", async () => {
  await act(async () => {
    expect(await controller.reconcileCloudState({ managedTunnel: false, publish: true })).toBe(
      true,
    );
  });
  expect(mocks.link).toHaveBeenCalledWith({
    target,
    clerkToken: "test-token",
    mode: "publish_only",
  });
  expect(mocks.unlink).not.toHaveBeenCalled();
  expect(mocks.preferences).toHaveBeenCalledWith({ target, publishAgentActivity: true });
});

it("fully unlinks when both capabilities are off, even with relay drift", async () => {
  await act(async () => {
    expect(await controller.reconcileCloudState({ managedTunnel: false, publish: false })).toBe(
      true,
    );
  });
  expect(mocks.unlink).toHaveBeenCalledWith({ target, clerkToken: "test-token" });
  expect(mocks.link).not.toHaveBeenCalled();
});

it("reports a failed repair without changing publishing and refreshes local state", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.link.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Relay unavailable"))));
  try {
    await act(async () => {
      expect(
        await controller.reconcileCloudState(
          { managedTunnel: true, publish: true },
          { forceRelink: true },
        ),
      ).toBe(false);
    });
    expect(controller.operationError).toBe("Relay unavailable");
    expect(mocks.preferences).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  } finally {
    consoleError.mockRestore();
  }
});
