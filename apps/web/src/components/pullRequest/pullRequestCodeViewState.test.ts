import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  getRenderablePatch,
  buildFileDiffIdentityKey,
  buildFileDiffContentVersion,
} from "~/lib/diffRendering";
import {
  isFileDiffCollapsed,
  mergePullRequestDiffSlices,
  restartPullRequestDiffPagination,
  toggleFileDiffFoldForViewed,
  type DiffSlice,
} from "./pullRequestDiff.logic";
import {
  EMPTY_CODE_VIEW,
  pullRequestCodeViewKey,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

import {
  PullRequestCodeScrollRestoration,
  observePullRequestCodeScrollIntent,
  savePullRequestCodeScroll,
  pullRequestCodeScrollSurface,
} from "./pullRequestCodeScroll.logic";
import { resolvePullRequestSelectionFile } from "./pullRequestSelection.logic";

const reference = {
  projectId: ProjectId.make("project-a"),
  host: "github.com",
  repository: "owner/repo",
  number: 7,
};
function session() {
  usePullRequestReviewStore.setState(usePullRequestReviewStore.getInitialState(), true);
  return usePullRequestReviewStore.getState().updateCodeView;
}
function reviewKey(thread: string | null = "thread-a", environment = "environment-a", number = 7) {
  return pullRequestCodeViewKey(environment, thread, { ...reference, number });
}
function page(after = "after"): DiffSlice {
  return {
    cursor: null,
    omittedFileStats: [],
    patch: Array.from({ length: 11 }, (_, index) =>
      [
        `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
        `--- a/src/file-${index}.ts`,
        `+++ b/src/file-${index}.ts`,
        "@@ -1 +1 @@",
        "-before",
        `+${after}`,
      ].join("\n"),
    ).join("\n"),
    nextCursor: null,
    truncated: false,
  };
}

describe("pull request Code tab session", () => {
  it("retains lightweight review choices after the active surface detaches", () => {
    const update = session();
    const key = reviewKey();
    update(key, () => ({
      selectedCommitOid: "commit-a",
      foldOverride: "folded",
      toggledFiles: new Set(["file-a", "file-b"]),
      scrollTop: 570,
      loadedPageCount: 3,
      chromeCondensed: true,
    }));
    const state = usePullRequestReviewStore.getState().codeViews[key]!;
    expect(state.selectedCommitOid).toBe("commit-a");
    expect(state.scrollTop).toBe(570);
    expect(state.chromeCondensed).toBe(true);
    expect(state.loadedPageCount).toBe(3);
    expect(isFileDiffCollapsed("file-a", state.foldOverride, state.toggledFiles)).toBe(false);
    expect(isFileDiffCollapsed("file-c", state.foldOverride, state.toggledFiles)).toBe(true);
  });

  it.each([
    ["another thread", reviewKey("thread-b")],
    ["global page", reviewKey(null)],
    ["another environment", reviewKey("thread-a", "environment-b")],
    ["another PR", reviewKey("thread-a", "environment-a", 8)],
  ])("separates review choices from %s", (_label, otherKey) => {
    const update = session();
    update(reviewKey(), (current) => ({
      ...current,
      selectedCommitOid: "commit-a",
      scrollTop: 570,
    }));
    update(otherKey, (current) => ({ ...current, selectedCommitOid: "commit-b" }));
    expect(usePullRequestReviewStore.getState().codeViews[reviewKey()]?.scrollTop).toBe(570);
    expect(usePullRequestReviewStore.getState().codeViews[otherKey]?.scrollTop).toBe(0);
  });

  it("bounds retained sessions and keeps a recently updated session", () => {
    const update = session();
    for (let number = 0; number < 32; number++)
      update(reviewKey(null, "env", number), () => ({ ...EMPTY_CODE_VIEW }));
    update(reviewKey(null, "env", 0), (current) => ({ ...current, scrollTop: 5 }));
    update(reviewKey(null, "env", 32), () => ({ ...EMPTY_CODE_VIEW }));
    const views = usePullRequestReviewStore.getState().codeViews;
    expect(Object.keys(views)).toHaveLength(32);
    expect(views[reviewKey(null, "env", 0)]?.scrollTop).toBe(5);
    expect(views[reviewKey(null, "env", 1)]).toBeUndefined();
  });

  it("bounds file overrides within a session, evicting the oldest overrides", () => {
    const update = session();
    update(reviewKey(), (current) => ({
      ...current,
      toggledFiles: new Set(Array.from({ length: 2049 }, (_, index) => `file-${index}`)),
    }));
    const saved = usePullRequestReviewStore.getState().codeViews[reviewKey()]!;
    expect(saved.toggledFiles.size).toBe(2048);
    expect(isFileDiffCollapsed("file-0", "folded", saved.toggledFiles)).toBe(true);
    expect(isFileDiffCollapsed("file-2048", "folded", saved.toggledFiles)).toBe(false);
  });

  it("does not notify consumers for a no-op update", () => {
    const update = session();
    const before = usePullRequestReviewStore.getState();
    update(reviewKey(), (current) => current);
    expect(usePullRequestReviewStore.getState()).toBe(before);
  });
});

describe("pull request refresh pages", () => {
  it("revalidates numeric cursor pages even when the first page is unchanged", () => {
    const first = { ...page(), nextCursor: "2" };
    const second = { ...page("old second page"), cursor: "2", nextCursor: "3" };
    const third = { ...page("old third page"), cursor: "3" };
    const saved = [first, second, third];
    const cache = new Map<string | null, DiffSlice>(saved.map((slice) => [slice.cursor, slice]));
    const fresh = new Map<string | null, DiffSlice>([
      [null, first],
      ["2", { ...second, patch: page("new second page").patch }],
      ["3", { ...third, patch: page("new third page").patch }],
    ]);
    const requested: (string | null)[] = [];
    const restarted = restartPullRequestDiffPagination("review", saved, (cursor) => {
      requested.push(cursor);
      cache.delete(cursor);
    });
    expect(requested).toEqual([null, "2", "3"]);
    const restore = new PullRequestCodeScrollRestoration({
      scrollTop: 1800,
      loadedPageCount: saved.length,
    });
    const surface = { scrollTop: 0, scrollHeight: 3000, clientHeight: 400 };
    let slices = restarted.slices;
    let cursor: string | null = restarted.cursor;
    for (let index = 0; index < saved.length; index++) {
      const next: DiffSlice = cache.get(cursor) ?? fresh.get(cursor)!;
      slices = mergePullRequestDiffSlices(slices, next);
      const result = restore.restore(surface, slices.length, next.nextCursor !== null);
      if (result === "restored") break;
      expect(result).toBe("load-more");
      expect(surface.scrollTop).toBe(0);
      cursor = next.nextCursor;
    }
    expect(slices).toEqual([...fresh.values()]);
    expect(slices[0]).toBe(first);
    expect(surface.scrollTop).toBe(1800);
    expect(restore.pending).toBe(false);
  });

  it.each([false, true])(
    "keeps all loaded pages when the first page is unchanged (new identity: %s)",
    (copy) => {
      const first = { ...page(), nextCursor: "next" };
      const second = { ...page(), cursor: "next" };
      const slices = [first, second];
      const merged = mergePullRequestDiffSlices(slices, copy ? { ...first } : first);
      expect(merged).toBe(slices);
      const parsed = getRenderablePatch(merged[0]!.patch, "review");
      expect(parsed?.kind === "files" && parsed.files.length).toBe(11);
    },
  );

  it("prunes pages after a changed first page", () => {
    const slices = [
      { ...page(), nextCursor: "next" },
      { ...page(), cursor: "next" },
    ];
    const changed = page("edited again");
    expect(mergePullRequestDiffSlices(slices, changed)).toEqual([changed]);
  });

  it("keeps preceding pages when a later page changes", () => {
    const first = { ...page(), nextCursor: "next" };
    const changed = { ...page("edited again"), cursor: "next" };
    expect(
      mergePullRequestDiffSlices(
        [first, { ...page(), cursor: "next" }, { ...page(), cursor: "last" }],
        changed,
      ),
    ).toEqual([first, changed]);
  });

  it("invalidates following cursors when omitted file stats change", () => {
    const first = { ...page(), nextCursor: "next" };
    const changed = {
      ...first,
      omittedFileStats: [{ path: "large.ts", additions: 2, deletions: 1 }],
    };
    expect(mergePullRequestDiffSlices([first, { ...page(), cursor: "next" }], changed)).toEqual([
      changed,
    ]);
  });
});
describe("pull request file keys", () => {
  it.each(["expanded", "folded"] as const)(
    "preserves a file toggle against the %s default after its patch changes",
    (foldOverride) => {
      const before = getRenderablePatch(page().patch, "review:page");
      const refreshed = getRenderablePatch(page("edited again").patch, "review:page");
      if (before?.kind !== "files" || refreshed?.kind !== "files") {
        throw new Error("fixture must parse as eleven files");
      }
      const originalKey = buildFileDiffIdentityKey(before.files[1]!);
      const refreshedKey = buildFileDiffIdentityKey(refreshed.files[1]!);
      const toggled = new Set([originalKey]);
      expect(isFileDiffCollapsed(refreshedKey, foldOverride, toggled)).toBe(
        isFileDiffCollapsed(originalKey, foldOverride, toggled),
      );
    },
  );

  it.each(["after", "edited again"])(
    "keeps path identity when a refreshed page has different parser cache keys (%s)",
    (content) => {
      const before = getRenderablePatch(page().patch, "review:page:old-hash");
      const refreshed = getRenderablePatch(page(content).patch, "review:page:new-hash");
      expect(before?.kind).toBe("files");
      expect(refreshed?.kind).toBe("files");
      if (before?.kind !== "files" || refreshed?.kind !== "files") {
        throw new Error("fixture must parse as eleven files");
      }
      expect(before.files).toHaveLength(11);
      expect(refreshed.files.map(buildFileDiffIdentityKey)).toEqual(
        before.files.map(buildFileDiffIdentityKey),
      );
      expect(new Set(before.files.map(buildFileDiffIdentityKey)).size).toBe(11);
    },
  );
});

describe("pull request scroll restoration", () => {
  it.each(["Enter", "F3"])(
    "keeps navigation from an already-open Find input (%s) while pages arrive",
    (key) => {
      const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
      const surface = Object.assign(new EventTarget(), {
        scrollTop: 0,
        scrollHeight: 600,
        clientHeight: 400,
      });
      const stop = observePullRequestCodeScrollIntent(surface, () => restore.cancel());
      expect(restore.restore(surface, 1, true)).toBe("load-more");
      surface.dispatchEvent(Object.assign(new Event("keydown"), { key }));
      surface.scrollTop = 120;
      surface.scrollHeight = 3000;
      expect(restore.restore(surface, 3, false)).toBe("waiting");
      expect(surface.scrollTop).toBe(120);
      stop();
    },
  );

  it("keeps a pending target when refresh arrives before its saved pages", () => {
    const initial = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    const surface = { scrollTop: 0, scrollHeight: 600, clientHeight: 400 };
    expect(initial.restore(surface, 1, true)).toBe("load-more");
    const refreshed = initial.restart(surface.scrollTop, 1);
    expect(refreshed.restore(surface, 1, true)).toBe("load-more");
    surface.scrollHeight = 3000;
    expect(refreshed.restore(surface, 3, false)).toBe("restored");
    expect(surface.scrollTop).toBe(1800);
    surface.scrollTop = 2000;
    const later = refreshed.restart(surface.scrollTop, 3);
    surface.scrollTop = 0;
    expect(later.restore(surface, 3, false)).toBe("restored");
    expect(surface.scrollTop).toBe(2000);
  });

  it.each(["expanded", "folded"] as const)(
    "keeps a keyboard Find match in a %s file when saved pages arrive",
    (foldOverride) => {
      const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
      const surface = Object.assign(new EventTarget(), {
        scrollTop: 0,
        scrollHeight: 600,
        clientHeight: 400,
      });
      const keyboardTarget = new EventTarget();
      const stop = observePullRequestCodeScrollIntent(surface, () => restore.cancel());
      expect(restore.restore(surface, 1, true)).toBe("load-more");
      keyboardTarget.dispatchEvent(
        Object.assign(new Event("keydown"), { key: "f", ctrlKey: true }),
      );
      expect(restore.pending).toBe(true);
      surface.dispatchEvent(Object.assign(new Event("keydown"), { key: "f", ctrlKey: true }));
      expect(restore.pending).toBe(false);
      const toggled = toggleFileDiffFoldForViewed("match", false, foldOverride, new Set());
      expect(isFileDiffCollapsed("match", foldOverride, toggled)).toBe(false);
      surface.scrollTop = 120;
      surface.scrollHeight = 3000;
      expect(restore.restore(surface, 3, false)).toBe("waiting");
      expect(surface.scrollTop).toBe(120);
      stop();
    },
  );

  it.each([570, 20_000_000, 29_999_590])(
    "restores logical offset %s without sticky drift or physical window clamping",
    (savedTop) => {
      let logicalTop = 0;
      const viewer = {
        getScrollTop: () => logicalTop,
        getScrollHeight: () => 30_000_000,
        getHeight: () => 400,
        getTopForItem: () => 80,
        scrollTo: (target: { offset?: number; type: string }) => {
          expect(target.type).toBe("item");
          logicalTop = 80 - (target.offset ?? 0);
        },
        render: () => {},
      };
      const surface = pullRequestCodeScrollSurface(viewer, "first-file");
      for (let trip = 0; trip < 3; trip++) {
        const restore = new PullRequestCodeScrollRestoration({
          scrollTop: savedTop,
          loadedPageCount: 1,
        });
        logicalTop = 0;
        expect(restore.restore(surface, 1, false)).toBe("restored");
        expect(logicalTop).toBe(savedTop);
      }
    },
  );

  it("expands saved condensed chrome when restoration clamps to zero without a scroll event", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    const surface = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };
    expect(restore.restore(surface, 1, false)).toBe("restored");
    const before = {
      ...EMPTY_CODE_VIEW,
      chromeCondensed: true,
      scrollTop: 1800,
      loadedPageCount: 3,
    };
    const after = savePullRequestCodeScroll(before, surface.scrollTop, 1);
    expect(after.chromeCondensed).toBe(false);
    expect(after.scrollTop).toBe(0);
    expect(after.loadedPageCount).toBe(1);
    expect(savePullRequestCodeScroll(after, 0, 1)).toBe(after);
  });
  it("waits for an in-flight page, then settles a clamp when that page fails", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    const surface = { scrollTop: 0, scrollHeight: 600, clientHeight: 400 };
    expect(restore.restore(surface, 1, false, true)).toBe("waiting");
    expect(restore.pending).toBe(true);
    expect(restore.restore(surface, 1, false, false)).toBe("restored");
    expect(surface.scrollTop).toBe(200);
    expect(restore.pending).toBe(false);
  });

  it("does not jump back after deliberate scrolling cancels a pending restore", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    const surface = { scrollTop: 0, scrollHeight: 600, clientHeight: 400 };
    expect(restore.restore(surface, 1, true)).toBe("load-more");
    restore.cancel();
    surface.scrollTop = 120;
    surface.scrollHeight = 3000;
    expect(restore.restore(surface, 3, false)).toBe("waiting");
    expect(surface.scrollTop).toBe(120);
    expect(restore.pending).toBe(false);
  });

  it.each(["pointerdown", "mousedown"])(
    "keeps the user's position when %s interrupts restoration before saved pages arrive",
    (eventType) => {
      const update = session();
      const key = reviewKey();
      update(key, (current) => ({ ...current, scrollTop: 1800, loadedPageCount: 3 }));
      const restore = new PullRequestCodeScrollRestoration(
        usePullRequestReviewStore.getState().codeViews[key]!,
      );
      const surface = Object.assign(new EventTarget(), {
        scrollTop: 0,
        scrollHeight: 600,
        clientHeight: 400,
      });
      let loadedPageCount = 1;
      const stopObserving = observePullRequestCodeScrollIntent(surface, () => {
        restore.cancel();
        update(key, (current) =>
          savePullRequestCodeScroll(current, surface.scrollTop, loadedPageCount),
        );
      });
      try {
        expect(restore.restore(surface, loadedPageCount, true)).toBe("load-more");
        // A native scrollbar targets the scrolling element itself.
        surface.dispatchEvent(new Event(eventType));
        surface.scrollTop = 120;
        surface.scrollHeight = 3000;
        loadedPageCount = 3;
        expect(restore.restore(surface, loadedPageCount, false)).toBe("waiting");
        expect(surface.scrollTop).toBe(120);
        expect(restore.pending).toBe(false);
        expect(usePullRequestReviewStore.getState().codeViews[key]?.loadedPageCount).toBe(1);
      } finally {
        stopObserving();
      }
      const before = usePullRequestReviewStore.getState();
      surface.dispatchEvent(new Event(eventType));
      expect(usePullRequestReviewStore.getState()).toBe(before);
    },
  );

  it("preserves an explicit file reveal when the remaining saved pages arrive", () => {
    let logicalTop = 0;
    const viewer = {
      getScrollTop: () => logicalTop,
      getScrollHeight: () => 3000,
      getHeight: () => 400,
      getTopForItem: (id: string) => (id === "revealed-file" ? 300 : 0),
      scrollTo: (target: { type: string; id?: string; offset?: number }) => {
        logicalTop = viewer.getTopForItem(target.id ?? "first-file") - (target.offset ?? 0);
      },
      render: () => {},
    };
    const surface = pullRequestCodeScrollSurface(viewer, "first-file");
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    expect(restore.restore(surface, 1, true)).toBe("load-more");
    restore.cancel();
    viewer.scrollTo({ type: "item", id: "revealed-file" });
    expect(restore.restore(surface, 3, false)).toBe("waiting");
    expect(viewer.getScrollTop()).toBe(300);
  });

  it("waits for saved pages without overwriting the offset with a first-page clamp", () => {
    const saved = { scrollTop: 1800, loadedPageCount: 3 };
    const restore = new PullRequestCodeScrollRestoration(saved);
    const surface = { scrollTop: 0, scrollHeight: 600, clientHeight: 400 };
    expect(restore.restore(surface, 0, false)).toBe("waiting");
    expect(restore.restore(surface, 1, true)).toBe("load-more");
    expect(restore.restore(surface, 2, true)).toBe("load-more");
    expect(surface.scrollTop).toBe(0);
    expect(restore.pending).toBe(true);
    surface.scrollHeight = 3000;
    expect(restore.restore(surface, 3, true)).toBe("restored");
    expect(surface.scrollTop).toBe(1800);
    expect(restore.pending).toBe(false);
    surface.scrollTop = 1900;
    expect(restore.restore(surface, 4, true)).toBe("waiting");
    expect(surface.scrollTop).toBe(1900);
  });

  it("restores raw offsets without losing the sticky header height on each roundtrip", () => {
    const surface = { scrollTop: 570, scrollHeight: 3000, clientHeight: 400 };
    for (let trip = 0; trip < 3; trip++) {
      const restore = new PullRequestCodeScrollRestoration({
        scrollTop: surface.scrollTop,
        loadedPageCount: 1,
      });
      surface.scrollTop = 0;
      expect(restore.restore(surface, 1, false)).toBe("restored");
      expect(surface.scrollTop).toBe(570);
    }
  });

  it("keeps the target pending while its tab has no viewport", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 570, loadedPageCount: 1 });
    const surface = { scrollTop: 0, scrollHeight: 3000, clientHeight: 0 };
    expect(restore.restore(surface, 1, false)).toBe("waiting");
    expect(restore.pending).toBe(true);
    surface.clientHeight = 400;
    expect(restore.restore(surface, 1, false)).toBe("restored");
    expect(surface.scrollTop).toBe(570);
  });

  it("stops paging and clamps once when the refreshed diff has fewer pages", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    const surface = { scrollTop: 0, scrollHeight: 600, clientHeight: 400 };
    expect(restore.restore(undefined, 1, false)).toBe("waiting");
    expect(restore.restore(surface, 1, false)).toBe("restored");
    expect(surface.scrollTop).toBe(200);
    expect(restore.pending).toBe(false);
  });
});

describe("pull request line anchors", () => {
  it("keeps an anchor through unrelated patch changes but rejects changed or removed code", () => {
    const before = getRenderablePatch(page().patch, "before");
    const after = getRenderablePatch(page("shifted code").patch, "after");
    const same = getRenderablePatch(page().patch, "different-page-cache-key");
    if (before?.kind !== "files" || after?.kind !== "files" || same?.kind !== "files") {
      throw new Error("fixture must parse as files");
    }
    const original = before.files[0]!;
    const anchor = {
      fileKey: buildFileDiffIdentityKey(original),
      contentVersion: buildFileDiffContentVersion(original),
    };
    expect(resolvePullRequestSelectionFile([same.files[0]!, ...after.files.slice(1)], anchor)).toBe(
      same.files[0],
    );
    expect(buildFileDiffIdentityKey(after.files[0]!)).toBe(anchor.fileKey);
    expect(resolvePullRequestSelectionFile(after.files, anchor)).toBeUndefined();
    expect(resolvePullRequestSelectionFile(before.files.slice(1), anchor)).toBeUndefined();
  });
});
