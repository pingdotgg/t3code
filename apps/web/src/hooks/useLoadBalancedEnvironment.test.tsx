import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type HostResourcesSnapshot } from "@t3tools/contracts";
import { Effect } from "effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serverEnvironment } from "../state/server";
import { useLoadBalancedEnvironment } from "./useLoadBalancedEnvironment";

vi.mock("../state/server", () => ({ serverEnvironment: { hostResources: vi.fn() } }));

const environmentId = EnvironmentId.make("remote");
const candidates = [environmentId];
const weights = {};
const healthy: HostResourcesSnapshot = {
  sampledAt: 0,
  cpuUtilization: 0.3,
  cpuCount: 12,
  availableMemoryBytes: 20_000,
  totalMemoryBytes: 32_000,
};
let response: HostResourcesSnapshot | Error;
let reads: number;
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
let result: ReturnType<typeof useLoadBalancedEnvironment>;

function Probe({ ids = candidates }: { ids?: readonly EnvironmentId[] }) {
  const value = useLoadBalancedEnvironment(ids, weights);
  useLayoutEffect(() => {
    result = value;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reads = 0;
  registry = AtomRegistry.make();
  const resources = Atom.make(
    Effect.suspend(() => {
      reads++;
      return response instanceof Error ? Effect.fail(response) : Effect.succeed(response);
    }),
  ).pipe(Atom.setIdleTTL(0));
  vi.mocked(serverEnvironment.hostResources).mockReturnValue(resources);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(ids = candidates) {
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <Probe ids={ids} />
      </RegistryContext.Provider>,
    );
  });
}

it.each([
  ["CPU saturation", { ...healthy, cpuUtilization: 0.98 }],
  ["memory pressure", { ...healthy, availableMemoryBytes: 1_000 }],
  ["a failed resource request", new Error("Resource check timed out")],
] as const)(
  "selects the recovered host after %s without reopening the draft",
  async (_, initial) => {
    response = initial;
    await mount();
    expect(result.environmentId).toBeNull();
    expect(result.pending).toBe(false);
    expect(reads).toBe(1);

    response = healthy;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(result.environmentId).toBe(environmentId);
    expect(reads).toBe(2);

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(reads).toBe(2);
  },
);

it("does not request resources with no eligible machines", async () => {
  response = healthy;
  await mount([]);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(reads).toBe(0);
  expect(result.status).toBe("no-candidates");
});

it("keeps retrying failed readings until the host recovers", async () => {
  response = new Error("Resource check timed out");
  await mount();
  expect(result.status).toBe("unavailable");
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(reads).toBe(2);
  expect(result.status).toBe("unavailable");
  response = healthy;
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(result.environmentId).toBe(environmentId);
  expect(reads).toBe(3);
});

it("cancels retries when automatic selection is disabled", async () => {
  response = { ...healthy, cpuUtilization: 1 };
  await mount();
  expect(result.status).toBe("at-capacity");
  await act(() => {
    renderer.update(
      <RegistryContext.Provider value={registry}>
        <Probe ids={[]} />
      </RegistryContext.Provider>,
    );
  });
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(reads).toBe(1);
});

it("stops retrying when the draft closes", async () => {
  response = new Error("Resource check timed out");
  await mount();
  await act(() => renderer.unmount());
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(reads).toBe(1);
});
