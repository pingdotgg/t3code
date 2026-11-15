import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useClosedViewStore } from "~/closedViewStore";
import { useRightPanelStore } from "~/rightPanelStore";

import {
  createFileReadingStore,
  createRevealLedger,
  liveFileSurface,
  type StorageLike,
} from "./fileReadingStore";

const DAY = 24 * 60 * 60 * 1000;
const file = { environmentId: "env-1", absolutePath: "/work/a.ts" };
const sourceKey = 't3code.fileReading.v1:["env-1","/work/a.ts","source"]';

function memoryStorage(options: { quota?: number } = {}) {
  const items = new Map<string, string>();
  let setCalls = 0;
  const used = () => [...items].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  const storage: StorageLike = {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      setCalls += 1;
      const previous = items.get(key);
      items.set(key, value);
      if (options.quota !== undefined && used() > options.quota) {
        if (previous === undefined) items.delete(key);
        else items.set(key, previous);
        throw new DOMException("full", "QuotaExceededError");
      }
    },
    removeItem: (key) => void items.delete(key),
  };
  return { storage, items, setCalls: () => setCalls };
}

function setup(storage: StorageLike | null = memoryStorage().storage) {
  const clock = { now: 1_000_000 };
  const readings = createFileReadingStore({ storage: () => storage, now: () => clock.now });
  return { clock, readings };
}

function setupPanel() {
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  useClosedViewStore.setState({ entries: [] });
  const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-reading"));
  return { ref, threadKey: scopedThreadKey(ref) };
}

const surfaceOf = (threadKey: string, relativePath: string) =>
  liveFileSurface(useRightPanelStore.getState().byThreadKey[threadKey], relativePath);

describe("file reading positions", () => {
  it("keys an entry by environment, absolute path and view", () => {
    const { items, storage } = memoryStorage();
    const { readings } = setup(storage);
    readings.writePosition(file, { view: "source", line: 12, offset: -4 });

    expect(JSON.parse(items.get(sourceKey)!)).toEqual({
      v: 1,
      at: 1_000_000,
      view: "source",
      line: 12,
      offset: -4,
    });
    expect(readings.readPosition(file, "source")).toEqual({ view: "source", line: 12, offset: -4 });
    expect(readings.readPosition(file, "rendered")).toBeNull();
    expect(readings.readPosition({ ...file, environmentId: "env-2" }, "source")).toBeNull();
    expect(setup(storage).readings.readPosition(file, "source")).toEqual({
      view: "source",
      line: 12,
      offset: -4,
    });
  });

  it("names the newest of a file's saved views", () => {
    const { clock, readings } = setup();
    expect(readings.newestView(file, ["source", "rendered"])).toBeNull();
    readings.writePosition(file, { view: "rendered", block: 3, fraction: 0.5 });
    clock.now += 1;
    readings.writePosition(file, { view: "source", line: 4, offset: 0 });
    expect(readings.newestView(file, ["source", "rendered"])).toBe("source");
    clock.now += 1;
    readings.writePosition(file, { view: "rendered", block: 4, fraction: 0 });
    expect(readings.newestView(file, ["source", "rendered"])).toBe("rendered");
  });

  it("expires an entry 30 days after it was written, and reads do not renew it", () => {
    const { items, storage } = memoryStorage();
    const { clock, readings } = setup(storage);
    readings.writePosition(file, { view: "source", line: 3, offset: 0 });
    clock.now += 30 * DAY - 1;
    expect(readings.readPosition(file, "source")?.line).toBe(3);
    clock.now += 1;
    expect(readings.readPosition(file, "source")).toBeNull();
    expect(items.has(sourceKey)).toBe(false);
  });

  it("keeps 300 positions, evicting the oldest, and leaves other keys alone", () => {
    const { items, storage } = memoryStorage();
    items.set("t3code.renderMarkdown", "true");
    const { clock, readings } = setup(storage);
    for (let index = 0; index < 301; index += 1) {
      clock.now += 1;
      readings.writePosition(
        { ...file, absolutePath: `/work/${index}.ts` },
        {
          view: "source",
          line: 1,
          offset: 0,
        },
      );
    }
    const positionKeys = [...items.keys()].filter((key) => key.startsWith("t3code.fileReading"));
    expect(positionKeys).toHaveLength(300);
    expect(items.has('t3code.fileReading.v1:["env-1","/work/0.ts","source"]')).toBe(false);
    expect(items.get("t3code.renderMarkdown")).toBe("true");
  });

  it("drops corrupt, wrong-version, out-of-range and expired entries on first use", () => {
    const { items, storage } = memoryStorage();
    const key = (path: string) => `t3code.fileReading.v1:["env-1","${path}","source"]`;
    items.set(key("/corrupt"), "{");
    items.set(
      key("/v2"),
      JSON.stringify({ v: 2, at: 1_000_000, view: "source", line: 1, offset: 0 }),
    );
    items.set(
      key("/line"),
      JSON.stringify({ v: 1, at: 1_000_000, view: "source", line: 0, offset: 0 }),
    );
    items.set(key("/infinite"), '{"v":1,"at":1000000,"view":"source","line":2,"offset":1e999}');
    items.set(
      't3code.fileReading.v1:["env-1","/fraction","rendered"]',
      JSON.stringify({ v: 1, at: 1_000_000, view: "rendered", block: 0, fraction: 1 }),
    );
    items.set(
      key("/old"),
      JSON.stringify({ v: 1, at: 1_000_000 - 31 * DAY, view: "source", line: 1, offset: 0 }),
    );
    items.set(
      "t3code.fileReveal.v1:not-json",
      JSON.stringify({ v: 1, at: 1_000_000, id: 1, line: 1 }),
    );
    items.set(
      key("/good"),
      JSON.stringify({ v: 1, at: 1_000_000, view: "source", line: 7, offset: -2 }),
    );
    const { readings } = setup(storage);

    expect(readings.readPosition({ ...file, absolutePath: "/corrupt" }, "source")).toBeNull();
    expect([...items.keys()]).toEqual([key("/good")]);
    expect(readings.readPosition({ ...file, absolutePath: "/good" }, "source")?.line).toBe(7);
  });

  it("frees the oldest half on a full quota, retries once, then keeps writes in memory", () => {
    const full = memoryStorage({ quota: 1_200 });
    const { clock, readings } = setup(full.storage);
    for (let index = 0; index < 20; index += 1) {
      clock.now += 1;
      readings.writePosition(
        { ...file, absolutePath: `/work/${index}.ts` },
        {
          view: "source",
          line: index + 1,
          offset: 0,
        },
      );
    }
    expect(full.items.has('t3code.fileReading.v1:["env-1","/work/19.ts","source"]')).toBe(true);
    expect(full.items.has('t3code.fileReading.v1:["env-1","/work/0.ts","source"]')).toBe(false);

    const tiny = memoryStorage({ quota: 10 });
    const stuck = setup(tiny.storage).readings;
    stuck.writePosition(file, { view: "source", line: 5, offset: 0 });
    expect(tiny.setCalls()).toBe(2);
    stuck.writePosition(
      { ...file, absolutePath: "/work/b.ts" },
      { view: "source", line: 6, offset: 0 },
    );
    expect(tiny.setCalls()).toBe(2);
    expect(stuck.readPosition(file, "source")?.line).toBe(5);
    expect(stuck.readPosition({ ...file, absolutePath: "/work/b.ts" }, "source")?.line).toBe(6);
  });

  it("serves from memory when storage is missing or throws", () => {
    const missing = setup(null).readings;
    missing.writePosition(file, { view: "pdf", page: 2, offset: 10, zoom: null, left: 0 });
    expect(missing.readPosition(file, "pdf")?.page).toBe(2);

    const throwing: StorageLike = {
      get length(): number {
        throw new Error("denied");
      },
      key: () => {
        throw new Error("denied");
      },
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const denied = setup(throwing).readings;
    expect(denied.readPosition(file, "source")).toBeNull();
    denied.writePosition(file, { view: "source", line: 9, offset: 0 });
    expect(denied.readPosition(file, "source")?.line).toBe(9);

    const blocked = createFileReadingStore({
      storage: () => {
        throw new Error("SecurityError");
      },
      now: () => 0,
    });
    blocked.writeReceipt("thread", "a.ts", { id: 1, line: 2 });
    expect(blocked.readReceipt("thread", "a.ts")).toEqual({ id: 1, line: 2 });
  });
});

describe("reveal receipts", () => {
  it("adopts a matching receipt so a reloaded citation restores instead of jumping", () => {
    const { ref, threadKey } = setupPanel();
    useRightPanelStore.getState().openFile(ref, "a.ts", 40);
    useRightPanelStore.getState().openFile(ref, "b.ts", 9);
    const { items, storage } = memoryStorage();
    setup(storage).readings.writeReceipt(threadKey, "a.ts", { id: 1, line: 40 });
    setup(storage).readings.writeReceipt(threadKey, "b.ts", { id: 1, line: 8 });
    setup(storage).readings.writeReceipt(threadKey, "gone.ts", { id: 1, line: 3 });

    const { readings } = setup(storage);
    const ledger = createRevealLedger(readings, useRightPanelStore, useClosedViewStore);

    expect(ledger.verdict(surfaceOf(threadKey, "a.ts"))).toBe("shown");
    expect(ledger.verdict(surfaceOf(threadKey, "b.ts"))).toBe("pending");
    expect(readings.readReceipt(threadKey, "gone.ts")).toEqual({ id: 1, line: 3, closed: true });
    expect([...items.keys()].some((key) => key.includes("gone.ts"))).toBe(true);
  });

  it("marks a thread's receipts closed when a tab closed before the ledger started", () => {
    const { ref, threadKey } = setupPanel();
    useRightPanelStore.getState().openFile(ref, "a.ts", 40);
    useRightPanelStore.getState().openFile(ref, "b.ts");
    useRightPanelStore.getState().closeSurface(ref, "file:b.ts");
    const { storage } = memoryStorage();
    setup(storage).readings.writeReceipt(threadKey, "a.ts", { id: 1, line: 40 });

    const { readings } = setup(storage);
    const ledger = createRevealLedger(readings, useRightPanelStore, useClosedViewStore);

    expect(ledger.verdict(surfaceOf(threadKey, "a.ts"))).toBe("pending");
    expect(readings.readReceipt(threadKey, "a.ts")).toEqual({ id: 1, line: 40, closed: true });
  });

  it("writes a receipt for a live tab only, and marks it closed when the tab closes", () => {
    const { ref, threadKey } = setupPanel();
    useRightPanelStore.getState().openFile(ref, "a.ts", 40);
    const { readings } = setup();
    const ledger = createRevealLedger(readings, useRightPanelStore, useClosedViewStore);
    const first = surfaceOf(threadKey, "a.ts")!;
    expect(ledger.verdict(first)).toBe("pending");

    useRightPanelStore.getState().openFile(ref, "a.ts", 41);
    ledger.markShown(threadKey, first);
    expect(ledger.verdict(first)).toBe("shown");
    expect(readings.readReceipt(threadKey, "a.ts")).toBeNull();

    const second = surfaceOf(threadKey, "a.ts")!;
    expect(ledger.verdict(second)).toBe("pending");
    expect(ledger.generation(second)).not.toBe(ledger.generation(first));
    ledger.markShown(threadKey, second);
    expect(readings.readReceipt(threadKey, "a.ts")).toEqual({ id: 2, line: 41 });

    useRightPanelStore.getState().closeSurface(ref, "file:a.ts");
    expect(readings.readReceipt(threadKey, "a.ts")).toEqual({ id: 2, line: 41, closed: true });
    useRightPanelStore.getState().openFile(ref, "a.ts", 41);
    const reopened = surfaceOf(threadKey, "a.ts")!;
    expect(reopened.revealRequestId).toBe(1);
    expect(ledger.verdict(reopened)).toBe("pending");
  });

  it("treats Reopen Closed View of a shown citation as shown, and a fresh citation as new", () => {
    const { ref, threadKey } = setupPanel();
    useRightPanelStore.getState().openFile(ref, "b.ts");
    useRightPanelStore.getState().openFile(ref, "a.ts", 40);
    const { readings } = setup();
    const ledger = createRevealLedger(readings, useRightPanelStore, useClosedViewStore);
    ledger.markShown(threadKey, surfaceOf(threadKey, "a.ts")!);
    const closedEntry = () =>
      useClosedViewStore
        .getState()
        .entries.find((entry) => entry.kind === "panel-tab" && entry.surface.id === "file:a.ts")!;

    useRightPanelStore.getState().closeSurface(ref, "file:a.ts");
    const entry = closedEntry();
    useRightPanelStore.getState().openFile(ref, "a.ts", 40);
    const reopened = surfaceOf(threadKey, "a.ts")!;
    expect(ledger.verdict(reopened)).toBe("pending");
    useClosedViewStore.getState().remove(entry.id);
    expect(ledger.verdict(reopened)).toBe("shown");
    expect(readings.readReceipt(threadKey, "a.ts")).toEqual({ id: 1, line: 40 });

    useRightPanelStore.getState().closeSurface(ref, "file:a.ts");
    useRightPanelStore.getState().openFile(ref, "a.ts", 40);
    expect(ledger.verdict(surfaceOf(threadKey, "a.ts"))).toBe("pending");
  });
});
