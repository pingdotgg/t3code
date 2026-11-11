import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";

import {
  getRenderablePatch,
  buildFileDiffIdentityKey,
  buildFileDiffContentVersion,
} from "~/lib/diffRendering";
import {
  isFileDiffCollapsed,
  applyPullRequestDiffPage,
  refreshPullRequestDiffPages,
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
import {
  isPullRequestSelectionStale,
  resolvePullRequestSelectionFile,
} from "./pullRequestSelection.logic";

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
  const source = {
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
  return { ...source, source, cursor: null };
}

describe("pull request Code tab session", () => {
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
});

describe("pull request refresh pages", () => {
  it("revalidates later numeric cursor pages even when the first page is unchanged", () => {
    const first = { ...page(), nextCursor: "2" };
    const second = { ...page("old second page"), cursor: "2", nextCursor: "3" };
    const third = { ...page("old third page"), cursor: "3" };
    const loaded = [first, second, third];
    const requested: (string | null)[] = [];
    refreshPullRequestDiffPages(loaded, (cursor) => requested.push(cursor));
    expect(requested).toEqual([null, "2", "3"]);

    const afterFirst = applyPullRequestDiffPage(loaded, { ...first });
    expect(afterFirst).toEqual({ cursor: "2", slices: loaded });
    expect(afterFirst.slices).toBe(loaded);
    const changedSecond = { ...second, patch: page("new second page").patch };
    expect(applyPullRequestDiffPage(afterFirst.slices, changedSecond)).toEqual({
      cursor: "2",
      slices: [first, changedSecond],
    });
  });

  it("stays on the last page once every loaded page is unchanged", () => {
    const loaded = [{ ...page(), nextCursor: "2" }, { ...page(), cursor: "2" }];
    expect(applyPullRequestDiffPage(loaded, { ...loaded[1]! })).toEqual({
      cursor: "2",
      slices: loaded,
    });
  });
});

describe("pull request scroll restoration", () => {
  it("waits for saved pages without overwriting the offset with a first-page clamp", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    const surface = { scrollTop: 0, scrollHeight: 600, clientHeight: 400 };
    expect(restore.restore(surface, 0, false)).toBe("waiting");
    expect(restore.restore(surface, 1, true)).toBe("load-more");
    expect(restore.restore(surface, 2, true, true)).toBe("waiting");
    expect(restore.restore(surface, 2, true)).toBe("load-more");
    expect(surface.scrollTop).toBe(0);
    surface.scrollHeight = 3000;
    expect(restore.restore(surface, 3, true)).toBe("restored");
    expect(surface.scrollTop).toBe(1800);
    surface.scrollTop = 1900;
    expect(restore.restore(surface, 4, true)).toBe("waiting");
    expect(surface.scrollTop).toBe(1900);
  });

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

  it.each(["pointerdown", "mousedown", "keydown", "wheel"])(
    "keeps the user's position when %s interrupts restoration",
    (eventType) => {
      const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
      const surface = Object.assign(new EventTarget(), {
        scrollTop: 0,
        scrollHeight: 600,
        clientHeight: 400,
      });
      const stop = observePullRequestCodeScrollIntent(surface, () => restore.cancel());
      expect(restore.restore(surface, 1, true)).toBe("load-more");
      surface.dispatchEvent(new Event(eventType));
      stop();
      surface.scrollTop = 120;
      surface.scrollHeight = 3000;
      expect(restore.restore(surface, 3, false)).toBe("waiting");
      expect(surface.scrollTop).toBe(120);
    },
  );

  it("keeps the target pending while its tab has no viewport", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 570, loadedPageCount: 1 });
    const surface = { scrollTop: 0, scrollHeight: 3000, clientHeight: 0 };
    expect(restore.restore(surface, 1, false)).toBe("waiting");
    surface.clientHeight = 400;
    expect(restore.restore(surface, 1, false)).toBe("restored");
    expect(surface.scrollTop).toBe(570);
  });

  it("clamps once when the refreshed diff has fewer pages, and expands condensed chrome", () => {
    const restore = new PullRequestCodeScrollRestoration({ scrollTop: 1800, loadedPageCount: 3 });
    const surface = { scrollTop: 0, scrollHeight: 400, clientHeight: 400 };
    expect(restore.restore(surface, 1, false)).toBe("restored");
    expect(surface.scrollTop).toBe(0);
    const saved = savePullRequestCodeScroll(
      { ...EMPTY_CODE_VIEW, chromeCondensed: true, scrollTop: 1800, loadedPageCount: 3 },
      surface.scrollTop,
      1,
    );
    expect(saved).toMatchObject({ chromeCondensed: false, scrollTop: 0, loadedPageCount: 1 });
    expect(savePullRequestCodeScroll(saved, 0, 1)).toBe(saved);
  });

  it("restores a logical offset beyond the viewer's physical scroll window", () => {
    let logicalTop = 0;
    const viewer = {
      getScrollTop: () => logicalTop,
      getScrollHeight: () => 30_000_000,
      getHeight: () => 400,
      getTopForItem: () => 80,
      scrollTo: (target: { type: string; offset?: number }) => {
        logicalTop = 80 - (target.offset ?? 0);
      },
      render: () => {},
    };
    const restore = new PullRequestCodeScrollRestoration({
      scrollTop: 20_000_000,
      loadedPageCount: 1,
    });
    expect(restore.restore(pullRequestCodeScrollSurface(viewer, "first-file"), 1, false)).toBe(
      "restored",
    );
    expect(logicalTop).toBe(20_000_000);
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
    // A file on a page not read yet keeps its anchor until the whole diff has loaded.
    expect(isPullRequestSelectionStale(before.files.slice(1), anchor, false)).toBe(false);
    expect(isPullRequestSelectionStale(before.files.slice(1), anchor, true)).toBe(true);
    expect(isPullRequestSelectionStale(after.files, anchor, false)).toBe(true);
  });
});
