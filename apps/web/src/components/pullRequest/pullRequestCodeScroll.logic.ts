import type { CodeView } from "@pierre/diffs";
import type { PullRequestCodeViewState } from "./pullRequestReviewStore";

interface SavedCodeScroll {
  readonly scrollTop: number;
  readonly loadedPageCount: number;
}

type ScrollSurface = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

export class PullRequestCodeScrollRestoration {
  pending = true;

  constructor(private readonly saved: SavedCodeScroll) {}

  cancel() {
    this.pending = false;
  }

  restart(scrollTop: number, loadedPageCount: number) {
    return new PullRequestCodeScrollRestoration({
      scrollTop: this.pending ? this.saved.scrollTop : scrollTop,
      loadedPageCount: Math.max(this.pending ? this.saved.loadedPageCount : 0, loadedPageCount),
    });
  }

  restore(
    surface: ScrollSurface | undefined,
    loadedPageCount: number,
    canLoadNextPage: boolean,
    isLoading = false,
  ) {
    if (!this.pending || loadedPageCount === 0 || isLoading) return "waiting";
    if (loadedPageCount < this.saved.loadedPageCount && canLoadNextPage) return "load-more";
    if (surface === undefined || surface.clientHeight === 0) return "waiting";
    // Wait for the saved pages, or the first page would permanently clamp the target.
    surface.scrollTop = Math.min(
      this.saved.scrollTop,
      Math.max(0, surface.scrollHeight - surface.clientHeight),
    );
    this.pending = false;
    return "restored";
  }
}

export function savePullRequestCodeScroll(
  current: PullRequestCodeViewState,
  scrollTop: number,
  loadedPageCount: number,
): PullRequestCodeViewState {
  const chromeCondensed = scrollTop < 4 ? false : current.chromeCondensed;
  return current.scrollTop === scrollTop &&
    current.loadedPageCount === loadedPageCount &&
    current.chromeCondensed === chromeCondensed
    ? current
    : { ...current, scrollTop, loadedPageCount, chromeCondensed };
}

export function pullRequestCodeScrollSurface(
  viewer: Pick<
    CodeView,
    "getScrollTop" | "getScrollHeight" | "getHeight" | "getTopForItem" | "scrollTo" | "render"
  >,
  firstItemId: string,
): ScrollSurface {
  return {
    get scrollTop() {
      return viewer.getScrollTop();
    },
    set scrollTop(top) {
      // Item alignment uses logical coordinates without position targets' sticky-header
      // subtraction. This also works beyond Pierre's rebased physical scroll window.
      viewer.scrollTo({
        type: "item",
        id: firstItemId,
        align: "start",
        offset: (viewer.getTopForItem(firstItemId) ?? 0) - top,
        behavior: "instant",
      });
      viewer.render(true);
    },
    get scrollHeight() {
      return viewer.getScrollHeight();
    },
    get clientHeight() {
      return viewer.getHeight();
    },
  };
}

export function observePullRequestCodeScrollIntent(surface: EventTarget, cancel: () => void) {
  surface.addEventListener("wheel", cancel, { passive: true });
  surface.addEventListener("touchmove", cancel, { passive: true });
  surface.addEventListener("pointerdown", cancel, { capture: true });
  // Native scrollbar interactions can emit mouse events without a pointer event.
  surface.addEventListener("mousedown", cancel, { capture: true });
  // Keyboard interaction in the viewer, including Find input, takes priority over restoration.
  surface.addEventListener("keydown", cancel, { capture: true });
  return () => {
    surface.removeEventListener("wheel", cancel);
    surface.removeEventListener("touchmove", cancel);
    surface.removeEventListener("pointerdown", cancel, { capture: true });
    surface.removeEventListener("mousedown", cancel, { capture: true });
    surface.removeEventListener("keydown", cancel, { capture: true });
  };
}
