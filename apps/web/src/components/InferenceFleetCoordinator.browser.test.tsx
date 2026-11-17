import { EnvironmentId, type InferenceProxyStatus } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import type { EnvironmentPresentation } from "../state/environments";

const state = vi.hoisted(() => ({
  environments: [] as EnvironmentPresentation[],
  statuses: new Map<string, { data: InferenceProxyStatus | null; dataUpdatedAt: number }>(),
  version: 0,
  listeners: new Set<() => void>(),
  route: vi.fn(),
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  snapshot() {
    return this.version;
  },
  publish() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  },
}));

vi.mock("../state/environments", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironments: () => {
      useSyncExternalStore(state.subscribe.bind(state), state.snapshot.bind(state));
      return { environments: state.environments };
    },
  };
});
vi.mock("../state/query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentQuery: (environmentId: string) => {
      useSyncExternalStore(state.subscribe.bind(state), state.snapshot.bind(state));
      const status = state.statuses.get(environmentId);
      return {
        data: status?.data ?? null,
        dataUpdatedAt: status?.dataUpdatedAt ?? 0,
        isPending: false,
        refresh: () => {},
      };
    },
  };
});
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      inferenceProxy: {
        canGrant: () => Atom.make(true),
        inferenceStatus: ({ environmentId }: { environmentId: string }) => environmentId,
        routeInference: {},
      },
      providersValueAtom: () => Atom.make([]),
    },
  };
});
vi.mock(import("../state/use-atom-command"), () => ({ useAtomCommand: () => state.route }));

import { InferenceFleetCoordinator } from "./InferenceFleetCoordinator";

const primaryId = EnvironmentId.make("primary");
const alternateId = EnvironmentId.make("alternate");
const consumerId = EnvironmentId.make("consumer");

function environment(
  id: typeof primaryId,
  phase: "connected" | "disconnected",
  routeHost?: typeof primaryId,
): EnvironmentPresentation {
  return {
    environmentId: id,
    label: id,
    connection: { phase },
    serverConfig: {
      environment: { capabilities: { inferenceProxy: true } },
      settings: {
        providerInstances: routeHost
          ? {
              codex: {
                driver: "codex",
                enabled: true,
                config: {
                  inferenceEnabled: true,
                  inferenceHostId: routeHost,
                  inferenceHostLabel: routeHost,
                  inferenceBaseUrl: `https://${routeHost}.example/api/inference`,
                  inferenceKey: "fixture-key",
                  inferenceModels: ["gpt-fixture"],
                  inferenceHomePath: "/fixture",
                },
              },
            }
          : {},
      },
    },
  } as unknown as EnvironmentPresentation;
}

function status(available: boolean): InferenceProxyStatus {
  return {
    enabled: true,
    sharing: true,
    running: true,
    version: "8.0.60",
    problem: null,
    accounts: [],
    availableDrivers: available ? ["codex"] : [],
    consumers: [],
    routes: [],
  };
}

it("registers connected fallback hosts once and reconsiders them when the primary route changes", async () => {
  state.listeners.clear();
  state.route.mockReset().mockResolvedValue({ _tag: "Success" });
  state.environments = [
    environment(primaryId, "connected"),
    environment(alternateId, "connected"),
    environment(consumerId, "connected", primaryId),
  ];
  state.statuses = new Map([
    [primaryId, { data: status(true), dataUpdatedAt: 1 }],
    [alternateId, { data: status(false), dataUpdatedAt: 1 }],
  ]);
  state.version = 0;

  await using _screen = await render(<InferenceFleetCoordinator />);
  expect(state.route).not.toHaveBeenCalled();

  await act(() => {
    state.environments = [
      environment(primaryId, "disconnected"),
      environment(alternateId, "connected"),
      environment(consumerId, "connected", primaryId),
    ];
    state.statuses.set(alternateId, { data: status(true), dataUpdatedAt: 2 });
    state.publish();
  });
  await vi.waitFor(() => expect(state.route).toHaveBeenCalledTimes(1));
  expect(state.route).toHaveBeenLastCalledWith({
    host: { environmentId: alternateId, label: alternateId },
    consumer: { environmentId: consumerId, label: consumerId },
    driver: "codex",
    fallback: true,
  });

  await act(() => {
    state.statuses.set(alternateId, { data: status(true), dataUpdatedAt: 3 });
    state.publish();
  });
  expect(state.route).toHaveBeenCalledTimes(1);

  await act(() => {
    state.environments = [
      environment(primaryId, "connected"),
      environment(alternateId, "connected"),
      environment(consumerId, "connected", primaryId),
    ];
    state.publish();
  });
  expect(state.route).toHaveBeenCalledTimes(1);

  await act(() => {
    state.environments = [
      environment(primaryId, "connected"),
      environment(alternateId, "connected"),
      environment(consumerId, "connected", alternateId),
    ];
    state.publish();
  });
  await vi.waitFor(() => expect(state.route).toHaveBeenCalledTimes(2));
  expect(state.route).toHaveBeenLastCalledWith({
    host: { environmentId: primaryId, label: primaryId },
    consumer: { environmentId: consumerId, label: consumerId },
    driver: "codex",
    fallback: true,
  });
});
