import type { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type DiscoveredEnvironments = Discovery.RelayEnvironmentDiscoveryState["environments"];
type Availability = "checking" | "online";

const discovery = vi.hoisted(() => ({
  state: null as Discovery.RelayEnvironmentDiscoveryState | null,
  listeners: new Set<() => void>(),
  register: vi.fn(),
}));

vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => ({ isLoaded: true, isSignedIn: true })) as never,
}));
vi.mock(import("./clerk/useT3ConnectAuthPrompt"), () => ({
  useT3ConnectAuthPrompt: () => ({ authPrompt: null, openAuthPrompt: vi.fn() }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { relayEnvironmentDiscovery } = await import("~/state/relay");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === relayEnvironmentDiscovery.refresh
        ? async () => AsyncResult.success(undefined)
        : discovery.register) as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    discovery.listeners.add(listener);
    return () => discovery.listeners.delete(listener);
  };
  const read = () => discovery.state!;
  return {
    ...(await original()),
    useRelayEnvironmentDiscovery: () => useSyncExternalStore(subscribe, read, read),
  };
});

import { T3ConnectSteps } from "./HostedEmptyState";

const laptopId = EnvironmentId.make("laptop");
const desktopId = EnvironmentId.make("desktop");

function linked(availability: Record<string, Availability>): DiscoveredEnvironments {
  return new Map(
    [laptopId, desktopId].map((environmentId) => [
      environmentId,
      {
        environment: {
          environmentId,
          label: environmentId,
          endpoint: {
            httpBaseUrl: "https://relay.example.test",
            wsBaseUrl: "wss://relay.example.test/ws",
            providerKind: "manual",
          },
          linkedAt: "2026-10-19T12:00:00.000Z",
        },
        availability: availability[environmentId]!,
        status: Option.none(),
        error: Option.none(),
      },
    ]),
  );
}

async function publish(environments: DiscoveredEnvironments) {
  discovery.state = { environments, refreshing: false, offline: false, error: Option.none() };
  await act(async () => {
    for (const listener of discovery.listeners) listener();
  });
}

const registeredIds = () =>
  discovery.register.mock.calls.map(([registration]) => registration.target.environmentId);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  discovery.listeners.clear();
  discovery.state = {
    environments: new Map(),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
  discovery.register.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// The first added computer replaces this screen with the app, so every
// registration has to start in the same pass, after all health checks finish.
it("adds every linked computer only after discovery finishes checking them", async () => {
  await act(async () => root.render(<T3ConnectSteps />));

  await publish(linked({ [laptopId]: "checking", [desktopId]: "checking" }));
  await publish(linked({ [laptopId]: "online", [desktopId]: "checking" }));
  expect(discovery.register).not.toHaveBeenCalled();

  await publish(linked({ [laptopId]: "online", [desktopId]: "online" }));
  expect(registeredIds().toSorted()).toEqual([desktopId, laptopId]);
});
