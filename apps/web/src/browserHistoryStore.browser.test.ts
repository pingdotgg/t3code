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
  },
])("$name", async ({ change, expected }) => {
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

    await vi.waitFor(() =>
      expect(storedHistory()).toHaveProperty("byProjectKey", expected.byProjectKey),
    );
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
