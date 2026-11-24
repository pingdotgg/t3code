import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { resetBrowserHistoryForTests, useBrowserHistoryStore } from "./browserHistoryStore";
import { randomUUID } from "./lib/utils";

const storageKey = "t3code:browser-history:v1";
const oldEntry = { url: "http://example.test/removed", lastVisitedAt: 1 };
const otherEntry = { url: "http://example.test/other", lastVisitedAt: 2 };
const page = { url: "http://localhost:3000/page", lastVisitedAt: 3, title: "Page" };

function storedHistory(): unknown {
  return JSON.parse(localStorage.getItem(storageKey) ?? "null")?.state;
}

function openHistoryFixture(disposables: DisposableStack) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(storageKey, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("history");
    request.onsuccess = () => {
      const db = request.result;
      disposables.defer(() => db.close());
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

function readHistoryFixture(db: IDBDatabase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction("history").objectStore("history").get(storageKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeHistoryFixture(db: IDBDatabase, state: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("history", "readwrite");
    transaction.objectStore("history").put(state, storageKey);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

it.each([
  {
    name: "records a visit without bringing back a deleted URL",
    change: () => useBrowserHistoryStore.getState().recordVisit("a", "http://example.test/new", 4),
    expected: {
      byProjectKey: {
        a: [{ url: "http://example.test/new", lastVisitedAt: 4 }, page],
        b: [otherEntry],
      },
    },
  },
  {
    name: "titles the latest matching visit without changing its URL",
    change: () =>
      useBrowserHistoryStore.getState().setTitleForUrl("a", "http://127.0.0.1:3000/page/", "New"),
    expected: { byProjectKey: { a: [{ ...page, title: "New" }], b: [otherEntry] } },
  },
  {
    name: "removes a visit added elsewhere without clearing the other project",
    change: () => useBrowserHistoryStore.getState().removeUrl("a", page.url),
    expected: { byProjectKey: { b: [otherEntry] } },
  },
  {
    name: "registers a thread without replacing another tab's history",
    change: () =>
      useBrowserHistoryStore.getState().registerThreadProject(
        {
          environmentId: EnvironmentId.make("env"),
          threadId: ThreadId.make("thread"),
        },
        "a",
      ),
    expected: { byProjectKey: { a: [page], b: [otherEntry] } },
  },
])("$name", async ({ change, expected }) => {
  await resetHistoryFixture();
  try {
    using fixture = new DisposableStack();
    const db = await openHistoryFixture(fixture);
    useBrowserHistoryStore.getState().recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
    await vi.waitFor(async () =>
      expect(await readHistoryFixture(db)).toMatchObject({ byProjectKey: { a: [oldEntry] } }),
    );

    // Another document has committed newer history that this store has not heard about.
    await writeHistoryFixture(db, {
      byProjectKey: { a: [page], b: [otherEntry] },
      projectKeyByThreadKey: {},
    });
    change();

    await vi.waitFor(async () => {
      const saved = await readHistoryFixture(db);
      expect(saved).toHaveProperty("byProjectKey", expected.byProjectKey);
      expect(saved).toHaveProperty(
        "projectKeyByThreadKey",
        useBrowserHistoryStore.getState().projectKeyByThreadKey,
      );
    });
    await vi.waitFor(() =>
      expect(useBrowserHistoryStore.getState().byProjectKey).toEqual(expected.byProjectKey),
    );
  } finally {
    await resetHistoryFixture();
  }
});

it("refreshes the open history when another document adds a visit", async () => {
  await resetHistoryFixture();
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
    );

    const otherStore = await openHistoryDocument();
    await vi.waitFor(() => expect(otherStore.getState().byProjectKey).toEqual({ a: [page] }));
    otherStore.getState().recordVisit("a", page.url, page.lastVisitedAt);

    await vi.waitFor(() =>
      expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({ a: [page] }),
    );
  } finally {
    await resetHistoryFixture();
  }
});

it("bounds saved thread mappings while keeping live registrations", async () => {
  await resetHistoryFixture();
  const mappings = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`env:thread-${index}`, "a"]),
  );

  try {
    using fixture = new DisposableStack();
    const db = await openHistoryFixture(fixture);
    await writeHistoryFixture(db, { byProjectKey: { a: [page] }, projectKeyByThreadKey: mappings });
    const store = useBrowserHistoryStore.getState();
    const environmentId = EnvironmentId.make("env");
    store.registerThreadProject({ environmentId, threadId: ThreadId.make("thread-0") }, "a");
    store.registerThreadProject({ environmentId, threadId: ThreadId.make("pending") }, "b");
    const { "env:thread-0": _oldest, ...retained } = mappings;
    await vi.waitFor(async () =>
      expect(await readHistoryFixture(db)).toHaveProperty("projectKeyByThreadKey", {
        ...retained,
        "env:pending": "b",
      }),
    );

    store.removeUrl("a", page.url);
    await vi.waitFor(async () =>
      expect(await readHistoryFixture(db)).toHaveProperty("projectKeyByThreadKey", {
        "env:pending": "b",
      }),
    );
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey["env:thread-0"]).toBe("a");
  } finally {
    await resetHistoryFixture();
  }
});

// A fresh module instance stands in for another tab: it gets its own store, IndexedDB connection
// and BroadcastChannel without an iframe reloading the app's whole module graph.
async function openHistoryDocument() {
  const source = new URL("./browserHistoryStore.ts", import.meta.url);
  source.searchParams.set("document", randomUUID());
  const module: typeof import("./browserHistoryStore") = await import(
    /* @vite-ignore */ source.href
  );
  return module.useBrowserHistoryStore;
}

function deleteHistoryDatabase() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(storageKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function resetHistoryFixture() {
  localStorage.removeItem(storageKey);
  await deleteHistoryDatabase();
  resetBrowserHistoryForTests();
}

it("moves the legacy snapshot into the shared database", async () => {
  await resetHistoryFixture();
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
  );
  try {
    const first = await openHistoryDocument();
    await vi.waitFor(() => expect(first.getState().byProjectKey).toEqual({ a: [page] }));
    expect(localStorage.getItem(storageKey)).toBeNull();
    first.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
    await vi.waitFor(() => expect(first.getState().byProjectKey.b).toEqual([otherEntry]));

    const reopened = await openHistoryDocument();
    await vi.waitFor(() =>
      expect(reopened.getState().byProjectKey).toEqual({ a: [page], b: [otherEntry] }),
    );
  } finally {
    await resetHistoryFixture();
  }
});

it("persists new visits from an open document after its history database is deleted", async () => {
  await resetHistoryFixture();
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
  );
  try {
    const first = await openHistoryDocument();
    await vi.waitFor(() => expect(first.getState().byProjectKey).toEqual({ a: [page] }));
    first.getState().removeUrl("a", page.url);
    await vi.waitFor(() => expect(first.getState().byProjectKey).toEqual({}));

    await deleteHistoryDatabase();
    first.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
    await vi.waitFor(() => expect(first.getState().byProjectKey.b).toEqual([otherEntry]));

    const reopened = await openHistoryDocument();
    await vi.waitFor(() => expect(reopened.getState().byProjectKey).toEqual({ b: [otherEntry] }));
  } finally {
    await resetHistoryFixture();
  }
});

it("keeps overlapping visits from independent documents", async () => {
  await resetHistoryFixture();
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
  );
  try {
    const [first, second] = await Promise.all([openHistoryDocument(), openHistoryDocument()]);
    first.getState().recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
    second.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
    const expected = { a: [page, oldEntry], b: [otherEntry] };
    await vi.waitFor(() => {
      expect(first.getState().byProjectKey).toEqual(expected);
      expect(second.getState().byProjectKey).toEqual(expected);
    });

    // A fresh document should read the committed visits even after the legacy seed is gone.
    localStorage.removeItem(storageKey);
    const reopened = await openHistoryDocument();
    await vi.waitFor(() => expect(reopened.getState().byProjectKey).toEqual(expected));
  } finally {
    await resetHistoryFixture();
  }
});

it("keeps visits saved while IndexedDB could not open", async () => {
  await resetHistoryFixture();
  try {
    using fixture = new DisposableStack();
    const db = await openHistoryFixture(fixture);
    await writeHistoryFixture(db, { byProjectKey: { a: [page] }, projectKeyByThreadKey: {} });
    vi.stubGlobal("indexedDB", {
      open() {
        throw new Error("blocked");
      },
    });
    try {
      const offline = await openHistoryDocument();
      offline.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
      await vi.waitFor(() =>
        expect(storedHistory()).toHaveProperty("byProjectKey", { b: [otherEntry] }),
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const online = await openHistoryDocument();
    await vi.waitFor(() =>
      expect(online.getState().byProjectKey).toEqual({ a: [page], b: [otherEntry] }),
    );
    expect(storedHistory()).toBeUndefined();
  } finally {
    await resetHistoryFixture();
  }
});
