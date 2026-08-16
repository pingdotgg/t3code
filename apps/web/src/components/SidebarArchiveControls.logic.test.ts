import { describe, expect, it, vi } from "vite-plus/test";

import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  canArchiveSettledSidebarThread,
  filterArchivableSidebarThreads,
  formatArchiveSkippedDescription,
  getCompletedArchiveThreadKeys,
  isThreadArchiveBlocked,
  isThreadSessionRunning,
  shouldRenderSidebarArchiveAll,
  withCoordinatedThreadArchiveEntries,
} from "./SidebarArchiveControls.logic";

describe("formatArchiveSkippedDescription", () => {
  it("describes eligibility skips without assuming why they happened", () => {
    expect(formatArchiveSkippedDescription(1)).toBe(
      "1 thread was no longer eligible for this archive action and was skipped.",
    );
    expect(formatArchiveSkippedDescription(2)).toBe(
      "2 threads were no longer eligible for this archive action and were skipped.",
    );
  });
});

describe("buildMultiSelectThreadContextMenuItems", () => {
  it("offers bulk archive with the selected count", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 3, hasArchiveBlockedThread: false }),
    ).toContainEqual({ id: "archive", label: "Archive (3)", disabled: false });
  });

  it("disables bulk archive when a selected thread has active work", () => {
    expect(
      buildMultiSelectThreadContextMenuItems({ count: 2, hasArchiveBlockedThread: true }),
    ).toContainEqual({ id: "archive", label: "Archive (2)", disabled: true });
  });
});

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("records every entry after full success", async () => {
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive: async (_entry, onArchived) => {
        onArchived();
        return success;
      },
    });

    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      skippedThreadKeys: [],
      mutationFailure: null,
      followupFailures: [],
    });
  });

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      skippedThreadKeys: [],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      skippedThreadKeys: [],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });

  it("reports completed entries before a later archive throws", async () => {
    const onArchived = vi.fn();

    await expect(
      archiveSelectedThreadEntries({
        entries,
        archive: async (entry, markArchived) => {
          if (entry.threadKey === "two") throw new Error("archive failed");
          markArchived();
          return success;
        },
        onArchived,
      }),
    ).rejects.toThrow("archive failed");

    expect(onArchived).toHaveBeenCalledTimes(1);
    expect(onArchived).toHaveBeenCalledWith(entries[0]);
  });

  it("re-checks eligibility before each batch mutation", async () => {
    const archive = vi.fn(async (_entry, markArchived: () => void) => {
      markArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive,
      canArchive: (entry) => entry.threadKey !== "two",
    });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenNthCalledWith(1, entries[0], expect.any(Function));
    expect(archive).toHaveBeenNthCalledWith(2, entries[2], expect.any(Function));
    expect(outcome.archivedThreadKeys).toEqual(["one", "three"]);
    expect(outcome.skippedThreadKeys).toEqual(["two"]);
  });

  it("reports when every entry becomes ineligible before mutation", async () => {
    const archive = vi.fn(async (_entry, markArchived: () => void) => {
      markArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({
      entries,
      archive,
      canArchive: () => false,
    });

    expect(archive).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      archivedThreadKeys: [],
      skippedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [],
    });
  });
});

describe("withCoordinatedThreadArchiveEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }] as const;

  it("coordinates separate callers through the shared reservation pool", async () => {
    const sharedEntry = { threadKey: "shared-one" } as const;
    let finishFirstFlow: (() => void) | undefined;
    const firstRun = vi.fn(
      async () =>
        new Promise<readonly string[]>((resolve) => {
          finishFirstFlow = () => resolve([sharedEntry.threadKey]);
        }),
    );
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [sharedEntry],
      run: firstRun,
    });
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce());

    const secondRun = vi.fn(async () => [sharedEntry.threadKey]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries: [sharedEntry],
      run: secondRun,
    });
    await Promise.resolve();
    expect(secondRun).not.toHaveBeenCalled();

    finishFirstFlow?.();
    await expect(Promise.all([firstFlow, secondFlow])).resolves.toEqual([
      [sharedEntry.threadKey],
      [],
    ]);
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("waits for owners and omits entries they successfully archived", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          finishFirstFlow = () => resolve(["one"]);
        }),
    });

    await vi.waitFor(() => expect(reservations.has("one")).toBe(true));
    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    await Promise.resolve();
    expect(secondRun).not.toHaveBeenCalled();

    finishFirstFlow?.();
    await expect(firstFlow).resolves.toEqual(["one"]);
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("retries entries when their owner cancels without archiving", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let cancelFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          cancelFirstFlow = () => resolve([]);
        }),
    });
    await vi.waitFor(() => expect(reservations.has("one")).toBe(true));
    const secondRun = vi.fn(async () => ["one", "two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });

    cancelFirstFlow?.();
    await expect(firstFlow).resolves.toEqual([]);
    await expect(secondFlow).resolves.toEqual(["one", "two"]);
    expect(secondRun).toHaveBeenCalledWith(entries, expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("releases reservations when the archive flow fails", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();

    await expect(
      withCoordinatedThreadArchiveEntries({
        entries,
        reservations,
        run: async () => {
          throw new Error("archive failed");
        },
      }),
    ).rejects.toThrow("archive failed");
    expect(reservations.size).toBe(0);
  });

  it("reserves uncontested siblings while waiting for an owner", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async () =>
        new Promise<readonly string[]>((resolve) => {
          finishFirstFlow = () => resolve(["one"]);
        }),
    });
    await vi.waitFor(() => expect(reservations.has("one")).toBe(true));

    let finishSecondFlow: (() => void) | undefined;
    const secondRun = vi.fn(
      async () =>
        new Promise<readonly string[]>((resolve) => {
          finishSecondFlow = () => resolve(["two"]);
        }),
    );
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    await vi.waitFor(() => expect(reservations.has("two")).toBe(true));

    const thirdRun = vi.fn(async () => ["two"]);
    const thirdFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[1]],
      reservations,
      run: thirdRun,
    });
    await Promise.resolve();
    expect(thirdRun).not.toHaveBeenCalled();

    finishFirstFlow?.();
    await expect(firstFlow).resolves.toEqual(["one"]);
    await vi.waitFor(() =>
      expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function)),
    );
    expect(thirdRun).not.toHaveBeenCalled();

    finishSecondFlow?.();
    await expect(secondFlow).resolves.toEqual(["two"]);
    await expect(thirdFlow).resolves.toEqual([]);
    expect(thirdRun).not.toHaveBeenCalled();
    expect(reservations.size).toBe(0);
  });

  it("publishes completed archives when a flow later throws", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let failFirstFlow: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: async (_ownedEntries, onArchived) => {
        onArchived("one");
        await new Promise<void>((_resolve, reject) => {
          failFirstFlow = () => reject(new Error("archive failed"));
        });
        return [];
      },
    });
    await vi.waitFor(() => expect(reservations.size).toBe(2));

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    failFirstFlow?.();

    await expect(firstFlow).rejects.toThrow("archive failed");
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("publishes intentional skips when a later archive throws", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let failArchive: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: async (ownedEntries, onCompleted) => {
        const outcome = await archiveSelectedThreadEntries({
          entries: ownedEntries,
          canArchive: (entry) => entry.threadKey !== "one",
          archive: async () =>
            new Promise<never>((_resolve, reject) => {
              failArchive = () => reject(new Error("archive failed"));
            }),
          onArchived: (entry) => onCompleted(entry.threadKey),
          onSkipped: (entry) => onCompleted(entry.threadKey),
        });
        return getCompletedArchiveThreadKeys(outcome);
      },
    });
    await vi.waitFor(() => expect(reservations.size).toBe(2));

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    failArchive?.();

    await expect(firstFlow).rejects.toThrow("archive failed");
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });

  it("does not retry entries an owner intentionally skipped", async () => {
    const reservations = new Map<string, Promise<ReadonlySet<string>>>();
    let finishEligibilityCheck: (() => void) | undefined;
    const firstFlow = withCoordinatedThreadArchiveEntries({
      entries: [entries[0]],
      reservations,
      run: async (ownedEntries) => {
        await new Promise<void>((resolve) => {
          finishEligibilityCheck = resolve;
        });
        const outcome = await archiveSelectedThreadEntries({
          entries: ownedEntries,
          archive: vi.fn(async () => ({ _tag: "Success" }) as const),
          canArchive: () => false,
        });
        return getCompletedArchiveThreadKeys(outcome);
      },
    });
    await vi.waitFor(() => expect(reservations.has("one")).toBe(true));

    const secondRun = vi.fn(async () => ["two"]);
    const secondFlow = withCoordinatedThreadArchiveEntries({
      entries,
      reservations,
      run: secondRun,
    });
    finishEligibilityCheck?.();

    await expect(firstFlow).resolves.toEqual(["one"]);
    await expect(secondFlow).resolves.toEqual(["two"]);
    expect(secondRun).toHaveBeenCalledWith([entries[1]], expect.any(Function));
    expect(reservations.size).toBe(0);
  });
});

describe("shouldRenderSidebarArchiveAll", () => {
  it("keeps the action mounted only while work exists or a batch is in flight", () => {
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 1, isArchiving: false })).toBe(true);
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 0, isArchiving: true })).toBe(true);
    expect(shouldRenderSidebarArchiveAll({ archivableCount: 0, isArchiving: false })).toBe(false);
  });
});

describe("archive lifecycle guards", () => {
  it("filters active turns and background work from archive batches", () => {
    const ready = { id: "ready", session: null };
    const starting = { id: "starting", session: { status: "starting" } };
    const running = {
      id: "running",
      session: { status: "running", activeTurnId: "turn-running" },
    };
    const working = { id: "working", session: null, backgroundLiveness: "working" as const };
    const monitoring = {
      id: "monitoring",
      session: null,
      backgroundLiveness: "monitoring" as const,
    };

    expect(isThreadSessionRunning(running.session)).toBe(true);
    expect(isThreadArchiveBlocked(ready)).toBe(false);
    expect(isThreadArchiveBlocked(starting)).toBe(true);
    expect(isThreadArchiveBlocked(running)).toBe(true);
    expect(isThreadArchiveBlocked(working)).toBe(true);
    expect(isThreadArchiveBlocked(monitoring)).toBe(true);
    expect(filterArchivableSidebarThreads([ready, starting, running, working, monitoring])).toEqual(
      [ready],
    );
  });

  it("re-checks settled membership and background work before archive", () => {
    const settledThreadKeys = new Set(["ready", "starting", "running"]);

    expect(
      canArchiveSettledSidebarThread({
        threadKey: "ready",
        settledThreadKeys,
        session: null,
        backgroundLiveness: null,
      }),
    ).toBe(true);
    expect(
      canArchiveSettledSidebarThread({
        threadKey: "starting",
        settledThreadKeys,
        session: { status: "starting" },
        backgroundLiveness: null,
      }),
    ).toBe(false);
    expect(
      canArchiveSettledSidebarThread({
        threadKey: "running",
        settledThreadKeys,
        session: { status: "running", activeTurnId: "turn-running" },
        backgroundLiveness: null,
      }),
    ).toBe(false);
    expect(
      canArchiveSettledSidebarThread({
        threadKey: "unsettled",
        settledThreadKeys,
        session: null,
        backgroundLiveness: null,
      }),
    ).toBe(false);
    for (const backgroundLiveness of ["working", "monitoring"] as const) {
      const threadKey = `thread-${backgroundLiveness}`;
      expect(
        canArchiveSettledSidebarThread({
          threadKey,
          settledThreadKeys: new Set([threadKey]),
          session: null,
          backgroundLiveness,
        }),
      ).toBe(false);
    }
  });
});
