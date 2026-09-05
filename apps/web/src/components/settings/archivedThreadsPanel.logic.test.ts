import { describe, expect, it } from "vite-plus/test";
import {
  archivedThreadDateSectionLabel,
  archivedThreadKey,
  archivedThreadRefKey,
  archivedThreadSortDate,
  archivedProjectKey,
  archivedProjectRefKey,
  filterAndSortArchivedThreads,
  runArchivedThreadBulkAction,
  type ArchivedThreadListEntry,
} from "./archivedThreadsPanel.logic";

const entries = [
  {
    thread: {
      id: "older",
      environmentId: "local",
      title: "Fix reconnect loop",
      archivedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    project: { id: "t3", environmentId: "local", name: "T3", cwd: "/dev/t3" },
  },
  {
    thread: {
      id: "newer",
      environmentId: "remote",
      title: "Pair mobile client",
      archivedAt: "2026-08-20T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    project: { id: "mobile", environmentId: "remote", name: "Mobile", cwd: "/dev/mobile" },
  },
] satisfies ArchivedThreadListEntry[];
const olderEntry = entries[0]!;
const newerEntry = entries[1]!;

describe("filterAndSortArchivedThreads", () => {
  it("uses the date represented by the active sort", () => {
    expect(archivedThreadSortDate(olderEntry.thread, "archived-desc")).toBe(
      olderEntry.thread.archivedAt,
    );
    expect(archivedThreadSortDate(olderEntry.thread, "created-desc")).toBe(
      olderEntry.thread.createdAt,
    );
    expect(archivedThreadSortDate(olderEntry.thread, "created-asc")).toBe(
      olderEntry.thread.createdAt,
    );
  });

  it("searches thread, project, and workspace text", () => {
    for (const query of ["reconnect", "t3", "/dev/t3"]) {
      expect(
        filterAndSortArchivedThreads(entries, {
          query,
          environmentId: "all",
          projectKey: "all",
          sort: "archived-desc",
        }).map(archivedThreadKey),
      ).toEqual([archivedThreadKey(olderEntry)]);
    }
  });

  it("combines environment and project filters", () => {
    expect(
      filterAndSortArchivedThreads(entries, {
        query: "",
        environmentId: "remote",
        projectKey: archivedProjectKey(newerEntry),
        sort: "archived-desc",
      }).map(archivedThreadKey),
    ).toEqual([archivedThreadKey(newerEntry)]);
  });

  it("supports archive and creation date ordering", () => {
    const keysFor = (sort: "archived-desc" | "archived-asc" | "created-desc" | "created-asc") =>
      filterAndSortArchivedThreads(entries, {
        query: "",
        environmentId: "all",
        projectKey: "all",
        sort,
      }).map(archivedThreadKey);

    expect(keysFor("archived-desc")).toEqual([
      archivedThreadKey(newerEntry),
      archivedThreadKey(olderEntry),
    ]);
    expect(keysFor("archived-asc")).toEqual([
      archivedThreadKey(olderEntry),
      archivedThreadKey(newerEntry),
    ]);
    expect(keysFor("created-desc")).toEqual([
      archivedThreadKey(olderEntry),
      archivedThreadKey(newerEntry),
    ]);
    expect(keysFor("created-asc")).toEqual([
      archivedThreadKey(newerEntry),
      archivedThreadKey(olderEntry),
    ]);
  });

  it("orders timestamps by instant when offsets differ", () => {
    const withOffsets = entries.map((entry, index) => ({
      ...entry,
      thread: {
        ...entry.thread,
        archivedAt: index === 0 ? "2026-08-20T01:00:00+02:00" : "2026-08-20T00:00:00.000Z",
      },
    }));
    expect(
      filterAndSortArchivedThreads(withOffsets, {
        query: "",
        environmentId: "all",
        projectKey: "all",
        sort: "archived-desc",
      }).map(archivedThreadKey),
    ).toEqual([archivedThreadKey(newerEntry), archivedThreadKey(olderEntry)]);
  });

  it("keeps environment-scoped thread and project keys collision-free", () => {
    const left = {
      ...olderEntry,
      thread: { ...olderEntry.thread, environmentId: "a", id: "b:c" },
      project: { ...olderEntry.project, environmentId: "a", id: "b:c" },
    };
    const right = {
      ...newerEntry,
      thread: { ...newerEntry.thread, environmentId: "a:b", id: "c" },
      project: { ...newerEntry.project, environmentId: "a:b", id: "c" },
    };

    expect(archivedThreadKey(left)).not.toBe(archivedThreadKey(right));
    expect(
      archivedThreadRefKey({ environmentId: left.thread.environmentId, threadId: left.thread.id }),
    ).toBe(archivedThreadKey(left));
    expect(archivedProjectKey(left)).not.toBe(archivedProjectKey(right));
    expect(
      archivedProjectRefKey({
        environmentId: left.project.environmentId,
        projectId: left.project.id,
      }),
    ).toBe(archivedProjectKey(left));
    expect(
      filterAndSortArchivedThreads([left, right], {
        query: "",
        environmentId: "all",
        projectKey: archivedProjectKey(left),
        sort: "archived-desc",
      }),
    ).toEqual([left]);
  });
});

describe("runArchivedThreadBulkAction", () => {
  it("bounds concurrency and reports failures", async () => {
    let active = 0;
    let peak = 0;
    const result = await runArchivedThreadBulkAction({
      entries: [1, 2, 3, 4, 5],
      concurrency: 2,
      isCancelled: () => false,
      action: async (entry) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return entry !== 3;
      },
    });

    expect(peak).toBe(2);
    expect(result).toEqual({ completedCount: 5, failedCount: 1, cancelled: false });
  });

  it("stops scheduling work after cancellation", async () => {
    let completed = 0;
    const result = await runArchivedThreadBulkAction({
      entries: [1, 2, 3, 4],
      concurrency: 1,
      isCancelled: () => completed === 2,
      action: async () => {
        completed += 1;
        return true;
      },
    });

    expect(result).toEqual({ completedCount: 2, failedCount: 0, cancelled: true });
  });

  it("counts rejected actions as failures and continues", async () => {
    const visited: number[] = [];
    const result = await runArchivedThreadBulkAction({
      entries: [1, 2, 3],
      concurrency: 1,
      isCancelled: () => false,
      action: async (entry) => {
        visited.push(entry);
        if (entry === 2) throw new Error("rejected");
        return true;
      },
    });

    expect(visited).toEqual([1, 2, 3]);
    expect(result).toEqual({ completedCount: 3, failedCount: 1, cancelled: false });
  });
});

describe("archivedThreadDateSectionLabel", () => {
  const now = new Date(2026, 8, 20, 12);

  it.each([
    [new Date(2026, 8, 20, 1).toISOString(), "Today"],
    [new Date(2026, 8, 19, 1).toISOString(), "Yesterday"],
    [new Date(2026, 8, 2, 1).toISOString(), "Earlier this month"],
    [new Date(2026, 7, 31, 1).toISOString(), "August"],
    [new Date(2025, 11, 1, 1).toISOString(), "December 2025"],
  ])("groups %s under %s", (isoDate, label) => {
    expect(archivedThreadDateSectionLabel(isoDate, now, "en-US")).toBe(label);
  });

  it("does not group future timestamps under Today", () => {
    expect(
      archivedThreadDateSectionLabel(new Date(2026, 8, 21, 1).toISOString(), now, "en-US"),
    ).toBe("September 21");
  });

  it("groups invalid timestamps without throwing", () => {
    expect(archivedThreadDateSectionLabel("not-a-date", now, "en-US")).toBe("Unknown date");
  });
});
