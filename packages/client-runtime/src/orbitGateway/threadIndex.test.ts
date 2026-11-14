import { describe, expect, it } from "vite-plus/test";

import { threadRuntimeIsActive } from "../state/models.ts";
import {
  createOrbitGatewayClient,
  parseOrbitThreadIndex,
  type OrbitThreadIndex,
  type OrbitThreadIndexRow,
} from "./client.ts";
import { joinOrbitInstanceThreads, type OrbitInstanceThreadInput } from "./instanceList.ts";
import {
  EMPTY_ORBIT_THREAD_INDEX_STATE,
  isIndexSubagentThreadId,
  nextOrbitThreadIndexState,
  orbitIndexThreadInput,
  orbitThreadInputsWithIndex,
  readOrbitThreadIndex,
} from "./threadIndex.ts";

function wireRow(overrides: Record<string, unknown> = {}) {
  return {
    environment_id: "inner-a",
    instance_id: 41,
    project_id: 3,
    thread_id: "t-1",
    title: "Fix the login",
    state: "completed",
    needs_input: false,
    last_user_message_at: "2026-11-14T10:00:00+00:00",
    last_run_completed_at: "2026-11-14T10:05:00+00:00",
    seen_at: "2026-11-14T14:00:00+00:00",
    ...overrides,
  };
}

function wireServer(environmentId: string, readAt: string | null, readError: string | null = null) {
  return {
    environment_id: environmentId,
    instance_id: 41,
    power_state: "running",
    read_at: readAt,
    read_error: readError,
  };
}

function row(overrides: Partial<OrbitThreadIndexRow> = {}): OrbitThreadIndexRow {
  return {
    environmentId: "inner-a",
    instanceId: 41,
    projectId: 3,
    threadId: "t-1",
    title: "Fix the login",
    state: "completed",
    needsInput: false,
    lastUserMessageAt: "2026-11-14T10:00:00+00:00",
    lastRunCompletedAt: "2026-11-14T10:05:00+00:00",
    seenAt: "2026-11-14T14:00:00+00:00",
    ...overrides,
  };
}

function index(
  rows: OrbitThreadIndexRow[],
  servers: Array<[string, string | null, (string | null)?]>,
): OrbitThreadIndex {
  return {
    rows,
    environments: servers.map(([environmentId, readAt, readError]) => ({
      environmentId,
      instanceId: 41,
      powerState: "running",
      readAt,
      readError: readError ?? null,
    })),
  };
}

function live(environmentId: string, id: string, title = id): OrbitInstanceThreadInput {
  return {
    environmentId,
    id,
    title,
    updatedAt: "2026-11-14T09:00:00Z",
    archivedAt: null,
    working: false,
  };
}

const T1 = "2026-11-14T14:00:00+00:00";
const T2 = "2026-11-14T14:01:00+00:00";

describe("parseOrbitThreadIndex", () => {
  it("reads rows and servers, and leaves out an entry that is not one", () => {
    const parsed = parseOrbitThreadIndex(
      [wireRow(), { thread_id: 5 }, wireRow({ thread_id: "t-2", state: null, needs_input: true })],
      { request_id: "r", environments: [wireServer("inner-a", T1), { nope: true }] },
    );
    expect(parsed?.rows.map((entry) => [entry.threadId, entry.state, entry.needsInput])).toEqual([
      ["t-1", "completed", false],
      ["t-2", null, true],
    ]);
    expect(parsed?.environments).toEqual([
      {
        environmentId: "inner-a",
        instanceId: 41,
        powerState: "running",
        readAt: T1,
        readError: null,
      },
    ]);
  });

  it("refuses an answer without lists", () => {
    expect(parseOrbitThreadIndex({}, { environments: [] })).toBeNull();
    expect(parseOrbitThreadIndex([], {})).toBeNull();
  });

  it("the client reads GET /threads without a query", async () => {
    const requests: unknown[] = [];
    const client = createOrbitGatewayClient(async (request) => {
      requests.push(request);
      return {
        status: 200,
        body: JSON.stringify({
          data: [wireRow()],
          meta: { request_id: "r", environments: [wireServer("inner-a", T1)] },
        }),
      };
    });
    const answer = await client.threads();
    expect(requests).toEqual([{ method: "GET", path: "/threads" }]);
    expect(answer.rows).toHaveLength(1);
  });
});

describe("orbitIndexThreadInput (the existing row model)", () => {
  it("maps title, last activity and working", () => {
    expect(orbitIndexThreadInput(row())).toEqual({
      environmentId: "inner-a",
      id: "t-1",
      title: "Fix the login",
      updatedAt: "2026-11-14T10:05:00+00:00",
      archivedAt: null,
      working: false,
    });
    // The later of the two times, whichever it is.
    expect(
      orbitIndexThreadInput(
        row({
          lastUserMessageAt: "2026-11-14T11:00:00Z",
          lastRunCompletedAt: "2026-11-14T10:00:00Z",
        }),
      ).updatedAt,
    ).toBe("2026-11-14T11:00:00Z");
    expect(
      orbitIndexThreadInput(row({ lastUserMessageAt: null, lastRunCompletedAt: null })).updatedAt,
    ).toBe("");
    // Such a row is no last use of its Instance (no stray "used" fact).
    const [joined] = joinOrbitInstanceThreads(
      [
        {
          id: 41,
          name: "feature-a",
          projectId: 3,
          projectSlug: "p",
          projectName: "P",
          nodeName: "beast",
          domain: null,
          instanceUrl: null,
          powerState: "running",
          status: "registered",
          environmentId: "inner-a",
          branch: null,
        },
      ],
      [orbitIndexThreadInput(row({ lastUserMessageAt: null, lastRunCompletedAt: null }))],
    );
    expect(joined?.lastUsedAt).toBeNull();
  });

  it("is working for exactly the statuses a live row shows as working", () => {
    for (const status of [
      "idle",
      "preparing",
      "queued",
      "starting",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]) {
      const liveWorking = threadRuntimeIsActive({ status } as never);
      expect(orbitIndexThreadInput(row({ state: status })).working, status).toBe(liveWorking);
    }
    expect(orbitIndexThreadInput(row({ state: null })).working).toBe(false);
  });

  it("a thread that needs input shows as a live one does: by its status only", () => {
    expect(orbitIndexThreadInput(row({ state: "waiting", needsInput: true })).working).toBe(true);
    // Live, an idle thread shows its time; the index row does too.
    expect(orbitIndexThreadInput(row({ state: "idle", needsInput: true })).working).toBe(false);
  });

  it("knows subagent threads by their T3 ids", () => {
    expect(isIndexSubagentThreadId("thread:subagent:0123456789abcdef")).toBe(true);
    expect(isIndexSubagentThreadId("thread:provider:codex:native-thread:01a1")).toBe(true);
    expect(isIndexSubagentThreadId("mcp:launch:abc")).toBe(false);
    expect(isIndexSubagentThreadId("thread:delegated-task:x")).toBe(false);
  });
});

describe("nextOrbitThreadIndexState", () => {
  it("takes a fresh read and drops a server the answer no longer covers", () => {
    const first = nextOrbitThreadIndexState(
      EMPTY_ORBIT_THREAD_INDEX_STATE,
      index(
        [row(), row({ environmentId: "inner-b", threadId: "t-b" })],
        [
          ["inner-a", T1],
          ["inner-b", T1],
        ],
      ),
    );
    expect([...first.servers.keys()]).toEqual(["inner-a", "inner-b"]);
    const second = nextOrbitThreadIndexState(first, index([], [["inner-a", T2]]));
    expect([...second.servers.keys()]).toEqual(["inner-a"]);
    expect(second.servers.get("inner-a")?.rows).toEqual([]);
  });

  it("a failed or older read keeps the last rows and shows nothing new", () => {
    const kept = nextOrbitThreadIndexState(
      EMPTY_ORBIT_THREAD_INDEX_STATE,
      index([row()], [["inner-a", T2]]),
    );
    const failed = nextOrbitThreadIndexState(
      kept,
      index([row({ threadId: "t-new" })], [["inner-a", T2, "conn.server_unreachable"]]),
    );
    expect(failed.servers.get("inner-a")).toBe(kept.servers.get("inner-a"));
    const older = nextOrbitThreadIndexState(
      kept,
      index([row({ threadId: "t-new" })], [["inner-a", T1]]),
    );
    expect(older.servers.get("inner-a")).toBe(kept.servers.get("inner-a"));
    const never = nextOrbitThreadIndexState(
      kept,
      index([row({ threadId: "t-new" })], [["inner-a", null]]),
    );
    expect(never.servers.get("inner-a")).toBe(kept.servers.get("inner-a"));
    // A failed call keeps everything.
    expect(nextOrbitThreadIndexState(kept, null)).toBe(kept);
  });
});

describe("orbitThreadInputsWithIndex", () => {
  const state = nextOrbitThreadIndexState(
    EMPTY_ORBIT_THREAD_INDEX_STATE,
    index(
      [
        row({ threadId: "t-index", title: "From the index" }),
        row({ threadId: "thread:subagent:abc", title: "A subagent" }),
        row({ environmentId: "inner-b", threadId: "t-b", title: "Connected's index row" }),
      ],
      [
        ["inner-a", T1],
        ["inner-b", T1],
      ],
    ),
  );
  const liveRows = [live("inner-a", "t-cached", "Cached"), live("inner-b", "t-live", "Live")];

  it("flag off: the live list itself, whatever the index holds", () => {
    expect(
      orbitThreadInputsWithIndex({
        enabled: false,
        live: liveRows,
        index: state,
        held: new Set(["inner-a"]),
      }),
    ).toBe(liveRows);
  });

  it("a held-off server shows its index rows in place of cached ones; a connected server never takes index rows", () => {
    const merged = orbitThreadInputsWithIndex({
      enabled: true,
      live: liveRows,
      index: state,
      held: new Set(["inner-a"]),
    });
    expect(merged.map((thread) => [thread.environmentId, thread.title])).toEqual([
      ["inner-b", "Live"],
      ["inner-a", "From the index"],
    ]);
  });

  it("a held-off server the index does not cover keeps its cached rows", () => {
    const merged = orbitThreadInputsWithIndex({
      enabled: true,
      live: liveRows,
      index: state,
      held: new Set(["inner-c"]),
    });
    expect(merged).toBe(liveRows);
  });

  it("a server that connects replaces its index rows with live ones, never both", () => {
    const held = orbitThreadInputsWithIndex({
      enabled: true,
      live: [live("inner-a", "t-index", "Old cached title")],
      index: state,
      held: new Set(["inner-a"]),
    });
    expect(held.map((thread) => thread.title)).toEqual(["From the index"]);
    const released = orbitThreadInputsWithIndex({
      enabled: true,
      live: [live("inner-a", "t-index", "Live title")],
      index: state,
      held: new Set(),
    });
    expect(released.map((thread) => thread.title)).toEqual(["Live title"]);
  });

  it("joins into the Orbit list's rows like live threads", () => {
    const merged = orbitThreadInputsWithIndex({
      enabled: true,
      live: [],
      index: state,
      held: new Set(["inner-a"]),
    });
    const [joined] = joinOrbitInstanceThreads(
      [
        {
          id: 41,
          name: "feature-a",
          projectId: 3,
          projectSlug: "p",
          projectName: "P",
          nodeName: "beast",
          domain: null,
          instanceUrl: null,
          powerState: "stopped",
          status: "registered",
          environmentId: "inner-a",
          branch: null,
        },
      ],
      merged,
    );
    expect(joined?.threads.map((thread) => thread.title)).toEqual(["From the index"]);
  });
});

describe("readOrbitThreadIndex", () => {
  const dies = async (): Promise<OrbitThreadIndex> => {
    throw new Error("the flag-off path must not read the index");
  };

  it("flag off: no call", async () => {
    let calls = 0;
    const result = await readOrbitThreadIndex({
      enabled: false,
      held: new Set(["inner-a"]),
      threads: async () => {
        calls += 1;
        return dies();
      },
    });
    expect(calls).toBe(0);
    expect(result).toBeNull();
  });

  it("nothing held: no call", async () => {
    let calls = 0;
    await readOrbitThreadIndex({
      enabled: true,
      held: new Set(),
      threads: async () => {
        calls += 1;
        return index([], []);
      },
    });
    expect(calls).toBe(0);
  });

  it("a failed call answers null, which keeps the last rows", async () => {
    const kept = nextOrbitThreadIndexState(
      EMPTY_ORBIT_THREAD_INDEX_STATE,
      index([row()], [["inner-a", T1]]),
    );
    const answer = await readOrbitThreadIndex({
      enabled: true,
      held: new Set(["inner-a"]),
      threads: dies,
    });
    expect(nextOrbitThreadIndexState(kept, answer)).toBe(kept);
  });
});
