import { EnvironmentId, type HostResourcesSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ThreadDetailsMachineLoad } from "./ThreadDetailsMachineLoad";

const environmentId = EnvironmentId.make("studio");
const state = vi.hoisted(() => ({
  phase: "connected",
  sample: null as unknown,
  presentationsAtom: Symbol("presentationsAtom"),
  resourcesAtom: Symbol("resourcesAtom"),
}));
vi.mock("../../state/presentation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/presentation")>();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: state.presentationsAtom,
    },
  };
});
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      liveHostResources: () => state.resourcesAtom,
    },
  };
});
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useServerConfigs: () => new Map(),
}));
vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: (atom: unknown, select?: (value: unknown) => unknown) => {
      if (atom === state.resourcesAtom) {
        return state.sample === null
          ? { _tag: "Initial", waiting: true }
          : { _tag: "Success", value: state.sample, waiting: false };
      }
      if (atom === state.presentationsAtom) {
        const presentations = new Map([[environmentId, { connection: { phase: state.phase } }]]);
        return select ? select(presentations) : presentations;
      }
      return (actual.useAtomValue as (...args: ReadonlyArray<unknown>) => unknown)(atom, select);
    },
  };
});

const GiB = 1024 ** 3;
const sample = (cpuUtilization: number) =>
  ({
    sampledAt: 1,
    cpuUtilization,
    cpuCount: 8,
    totalMemoryBytes: 16 * GiB,
    availableMemoryBytes: 8 * GiB,
  }) as HostResourcesSnapshot;

describe("ThreadDetailsMachineLoad", () => {
  it("hides the sample held across a reconnect until a fresh one arrives", async () => {
    state.phase = "connected";
    state.sample = sample(0.42);
    await using screen = await render(<ThreadDetailsMachineLoad environmentId={environmentId} />);
    expect(screen.container.textContent).toContain("42%");

    state.phase = "backoff";
    await screen.rerender(<ThreadDetailsMachineLoad environmentId={environmentId} />);
    expect(screen.container.textContent).toBe("");

    // Reconnected, but the refresh has not answered yet: the query still holds the old sample.
    state.phase = "connected";
    await screen.rerender(<ThreadDetailsMachineLoad environmentId={environmentId} />);
    expect(screen.container.textContent).toBe("");

    state.sample = sample(0.17);
    await screen.rerender(<ThreadDetailsMachineLoad environmentId={environmentId} />);
    expect(screen.container.textContent).toContain("17%");
  });
});
