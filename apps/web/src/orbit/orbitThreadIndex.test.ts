import type { OrbitThreadIndex } from "@t3tools/client-runtime/orbit-gateway";
import { EMPTY_ORBIT_THREAD_INDEX_STATE } from "@t3tools/client-runtime/orbit-gateway";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  createOrbitThreadIndex,
  orbitListThreadInputs,
  useOrbitThreadIndexStore,
} from "./orbitThreadIndex";

const ANSWER: OrbitThreadIndex = {
  rows: [
    {
      environmentId: "inner-a",
      instanceId: 41,
      projectId: 3,
      threadId: "t-1",
      title: "From the index",
      state: "idle",
      needsInput: false,
      lastUserMessageAt: null,
      lastRunCompletedAt: null,
      seenAt: "2026-11-14T14:00:00Z",
    },
  ],
  environments: [
    {
      environmentId: "inner-a",
      instanceId: 41,
      powerState: "running",
      readAt: "2026-11-14T14:00:00Z",
      readError: null,
    },
  ],
};

function harness(enabled: boolean, held: string[]) {
  const calls = { heldNow: 0, threads: 0 };
  const index = createOrbitThreadIndex({
    enabled: () => enabled,
    heldNow: async () => {
      calls.heldNow += 1;
      return new Set(held);
    },
  });
  const client = {
    threads: async () => {
      calls.threads += 1;
      return ANSWER;
    },
  };
  return { index, client, calls };
}

describe("createOrbitThreadIndex", () => {
  beforeEach(() => {
    useOrbitThreadIndexStore.setState({ index: EMPTY_ORBIT_THREAD_INDEX_STATE, held: new Set() });
  });

  it("flag off: no registry read, no Gateway call, the store stays empty", async () => {
    const { index, client, calls } = harness(false, ["inner-a"]);
    await index.load(client);
    await index.refreshHeld();
    expect(calls).toEqual({ heldNow: 0, threads: 0 });
    expect(useOrbitThreadIndexStore.getState().index).toBe(EMPTY_ORBIT_THREAD_INDEX_STATE);
    expect(useOrbitThreadIndexStore.getState().held.size).toBe(0);
  });

  it("flag on, nothing held: no Gateway call", async () => {
    const { index, client, calls } = harness(true, []);
    await index.load(client);
    expect(calls).toEqual({ heldNow: 1, threads: 0 });
  });

  it("flag on with a held-off server: one index read, kept in the store", async () => {
    const { index, client, calls } = harness(true, ["inner-a"]);
    await index.load(client);
    expect(calls.threads).toBe(1);
    const state = useOrbitThreadIndexStore.getState();
    expect([...state.held]).toEqual(["inner-a"]);
    expect(state.index.servers.get("inner-a")?.rows.map((row) => row.title)).toEqual([
      "From the index",
    ]);
  });

  it("a failed read keeps the last rows", async () => {
    const { index, client } = harness(true, ["inner-a"]);
    await index.load(client);
    const kept = useOrbitThreadIndexStore.getState().index;
    await index.load({
      threads: async () => {
        throw new Error("gateway down");
      },
    });
    expect(useOrbitThreadIndexStore.getState().index).toBe(kept);
  });

  it("a read that answers after a newer one does not undo it", async () => {
    const { index } = harness(true, ["inner-a"]);
    const answers: Array<(value: OrbitThreadIndex) => void> = [];
    let bothAsked: () => void = () => {};
    const asked = new Promise<void>((resolve) => (bothAsked = resolve));
    const client = {
      threads: () =>
        new Promise<OrbitThreadIndex>((resolve) => {
          answers.push(resolve);
          if (answers.length === 2) bothAsked();
        }),
    };
    const older = index.load(client);
    const newer = index.load(client);
    await asked;
    const at = (readAt: string, title: string): OrbitThreadIndex => ({
      rows: [{ ...ANSWER.rows[0]!, title }],
      environments: [{ ...ANSWER.environments[0]!, readAt }],
    });
    answers[1]!(at("2026-11-14T14:02:00Z", "Newer"));
    await newer;
    answers[0]!(at("2026-11-14T14:01:00Z", "Older"));
    await older;
    expect(useOrbitThreadIndexStore.getState().index.servers.get("inner-a")?.rows[0]?.title).toBe(
      "Newer",
    );
  });
});

describe("orbitListThreadInputs (the Instances page's threads)", () => {
  it("flag off: the live list itself, even with a held server and index rows", async () => {
    useOrbitThreadIndexStore.setState({ index: EMPTY_ORBIT_THREAD_INDEX_STATE, held: new Set() });
    const { index, client } = harness(true, ["inner-a"]);
    await index.load(client);
    const live = [
      {
        environmentId: "inner-a",
        id: "t-cached",
        title: "Cached",
        updatedAt: "2026-11-14T09:00:00Z",
        archivedAt: null,
        working: false,
      },
    ];
    const store = useOrbitThreadIndexStore.getState();
    expect(orbitListThreadInputs(live, store, false)).toBe(live);
    expect(orbitListThreadInputs(live, store, true).map((thread) => thread.title)).toEqual([
      "From the index",
    ]);
  });
});
