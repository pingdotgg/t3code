import { describe, expect, it, vi } from "vite-plus/test";

import { loadOrbitInstanceList, useOrbitInstanceListStore } from "./orbitInstanceList";
import { loadOrbitThreadIndex } from "./orbitThreadIndex";

const mocks = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./OrbitProfileSync", () => ({ desktopOrbitGatewayClient: () => mocks.client }));
// The flag `connAttachedServers` as the desktop stores it: off.
vi.mock(import("./attachedServersSeed"), async (importOriginal) => ({
  ...(await importOriginal()),
  readAttachedServersFlag: () => false,
}));
// The registry holds a server off, so only the flag keeps the index from being read.
vi.mock(import("@t3tools/client-runtime/state/runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  runAtomCommand: (async () => ({
    _tag: "Success",
    value: new Map([["env-one", new Set(["not-attached"])]]),
  })) as never,
}));

const record = (instanceId: number, instanceName: string) => ({
  environmentId: `env-${instanceName}`,
  label: instanceName,
  url: "http://x",
  serverVersion: null,
  registeredBy: null,
  registeredAt: null,
  status: "registered" as const,
  instanceId,
  powerState: "running" as const,
  projectId: 5,
  projectName: "nckrtl",
  projectSlug: "nckrtl",
  instanceName,
  nodeName: "beast",
  instanceUrl: null,
});

describe("loadOrbitInstanceList", () => {
  it("flag connAttachedServers off: never reads the thread index", async () => {
    useOrbitInstanceListStore.setState({ state: { status: "loading" }, generation: 0 });
    let threads = 0;
    mocks.client = {
      environments: async () => [record(1, "one")],
      projects: async () => [],
      threads: async () => {
        threads += 1;
        throw new Error("the flag-off path must not read the thread index");
      },
    };
    await loadOrbitInstanceList();
    // The list starts the index read without waiting; run the same read to its end.
    await loadOrbitThreadIndex(mocks.client as never);
    expect(threads).toBe(0);
    expect(useOrbitInstanceListStore.getState().state.status).toBe("loaded");
  });

  it("keeps the newest read when an older one answers last, and the last good list on refresh", async () => {
    useOrbitInstanceListStore.setState({ state: { status: "loading" }, generation: 0 });
    const answers: Array<(value: unknown[]) => void> = [];
    mocks.client = {
      environments: () => new Promise((resolve) => answers.push(resolve)),
      projects: async () => [],
    };
    const first = loadOrbitInstanceList();
    const second = loadOrbitInstanceList();
    answers[1]!([record(2, "newer")]);
    await second;
    answers[0]!([record(1, "older")]);
    await first;
    const names = () => {
      const { state } = useOrbitInstanceListStore.getState();
      return state.status === "loaded" ? state.rows.map((row) => row.name) : state.status;
    };
    expect(names()).toEqual(["newer"]);

    const refresh = loadOrbitInstanceList();
    expect(names()).toEqual(["newer"]);
    answers[2]!([]);
    await refresh;
    expect(names()).toEqual([]);
  });
});
