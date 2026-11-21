import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { resetBrowserHistoryForTests, useBrowserHistoryStore } from "./browserHistoryStore";

const storageKey = "t3code:browser-history:v1";
const oldEntry = { url: "http://example.test/removed", lastVisitedAt: 1 };
const otherEntry = { url: "http://example.test/other", lastVisitedAt: 2 };
const page = { url: "http://localhost:3000/page", lastVisitedAt: 3, title: "Page" };

function storedHistory(): unknown {
  return JSON.parse(localStorage.getItem(storageKey) ?? "null")?.state;
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
    expectedMappings: { "env:thread": "a" },
  },
])("$name", async ({ change, expected, expectedMappings }) => {
  resetBrowserHistoryForTests();
  try {
    useBrowserHistoryStore.getState().recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
    await vi.waitFor(() =>
      expect(storedHistory()).toMatchObject({ byProjectKey: { a: [oldEntry] } }),
    );

    // A second document has written a newer snapshot, but this store has not heard about it.
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        state: { byProjectKey: { a: [page], b: [otherEntry] }, projectKeyByThreadKey: {} },
        version: 1,
      }),
    );
    change();

    await vi.waitFor(() => {
      expect(storedHistory()).toHaveProperty("byProjectKey", expected.byProjectKey);
      if (expectedMappings) {
        expect(storedHistory()).toHaveProperty("projectKeyByThreadKey", expectedMappings);
      }
    });
    expect(useBrowserHistoryStore.getState().byProjectKey).toEqual(expected.byProjectKey);
  } finally {
    resetBrowserHistoryForTests();
  }
});

it("refreshes the open history when another document adds a visit", async () => {
  resetBrowserHistoryForTests();
  const frame = document.createElement("iframe");
  document.body.append(frame);
  try {
    frame.contentWindow!.localStorage.setItem(
      storageKey,
      JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
    );

    await vi.waitFor(() =>
      expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({ a: [page] }),
    );
  } finally {
    frame.remove();
    resetBrowserHistoryForTests();
  }
});

it("bounds saved thread mappings while keeping live registrations", async () => {
  resetBrowserHistoryForTests();
  const mappings = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`env:thread-${index}`, "a"]),
  );
  localStorage.setItem(
    storageKey,
    JSON.stringify({
      state: { byProjectKey: { a: [page] }, projectKeyByThreadKey: mappings },
      version: 1,
    }),
  );

  try {
    const store = useBrowserHistoryStore.getState();
    const environmentId = EnvironmentId.make("env");
    store.registerThreadProject({ environmentId, threadId: ThreadId.make("thread-0") }, "a");
    store.registerThreadProject({ environmentId, threadId: ThreadId.make("pending") }, "b");
    const { "env:thread-0": _oldest, ...retained } = mappings;
    await vi.waitFor(() =>
      expect(storedHistory()).toHaveProperty("projectKeyByThreadKey", {
        ...retained,
        "env:pending": "b",
      }),
    );

    store.removeUrl("a", page.url);
    await vi.waitFor(() =>
      expect(storedHistory()).toHaveProperty("projectKeyByThreadKey", { "env:pending": "b" }),
    );
    expect(useBrowserHistoryStore.getState().projectKeyByThreadKey["env:thread-0"]).toBe("a");
  } finally {
    resetBrowserHistoryForTests();
  }
});

async function openHistoryDocument(disposables: DisposableStack) {
  const source = new URL(import.meta.url);
  source.pathname = source.pathname.replace(/\.browser\.test\.ts$/, ".ts");
  source.search = "";
  const frame = document.createElement("iframe");
  disposables.defer(() => frame.remove());
  frame.srcdoc = `<script>Object.defineProperty(navigator, "locks", { value: undefined });</script>
    <script type="module">
      import { useBrowserHistoryStore } from ${JSON.stringify(source.href)};
      window.historyStore = useBrowserHistoryStore;
    </script>`;
  await new Promise<void>((resolve) => {
    frame.onload = () => resolve();
    document.body.append(frame);
  });
  const store = (
    frame.contentWindow as (Window & { historyStore?: typeof useBrowserHistoryStore }) | null
  )?.historyStore;
  if (!store) throw new Error("The history document did not load.");
  return store;
}

it("keeps overlapping visits from independent documents without Web Locks", async () => {
  resetBrowserHistoryForTests();
  localStorage.setItem(
    storageKey,
    JSON.stringify({ state: { byProjectKey: { a: [page] } }, version: 1 }),
  );
  try {
    using documents = new DisposableStack();
    const [first, second] = await Promise.all([
      openHistoryDocument(documents),
      openHistoryDocument(documents),
    ]);
    first.getState().recordVisit("a", oldEntry.url, oldEntry.lastVisitedAt);
    second.getState().recordVisit("b", otherEntry.url, otherEntry.lastVisitedAt);
    const expected = { a: [page, oldEntry], b: [otherEntry] };
    await vi.waitFor(() => {
      expect(first.getState().byProjectKey).toEqual(expected);
      expect(second.getState().byProjectKey).toEqual(expected);
    });

    // A fresh document should read the committed visits even after the legacy seed is gone.
    localStorage.removeItem(storageKey);
    const reopened = await openHistoryDocument(documents);
    await vi.waitFor(() => expect(reopened.getState().byProjectKey).toEqual(expected));
  } finally {
    resetBrowserHistoryForTests();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(storageKey);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
});
