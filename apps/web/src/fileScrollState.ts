import { LRUCache } from "./lib/lruCache";

const FILE_SCROLL_CACHE_SIZE = 500;
const FILE_SCROLL_POSITION_BYTES = 32;

export type FileScrollSurface = "markdown" | "source";

interface FileScrollPosition {
  readonly scrollTop: number;
  readonly scrollRange: number;
  readonly surface: FileScrollSurface;
  readonly anchorLine: number | null;
}

const fileScrollPositions = new LRUCache<FileScrollPosition>(
  FILE_SCROLL_CACHE_SIZE,
  FILE_SCROLL_CACHE_SIZE * FILE_SCROLL_POSITION_BYTES,
);

// A citation reveal scrolls a file once. Remembering that per session, keyed like scroll
// positions, lets a remounted panel restore the reader's later position instead of re-revealing.
const handledFileReveals = new LRUCache<number>(
  FILE_SCROLL_CACHE_SIZE,
  FILE_SCROLL_CACHE_SIZE * FILE_SCROLL_POSITION_BYTES,
);

export function rememberHandledFileReveal(key: string, revealRequestId: number): void {
  handledFileReveals.set(key, revealRequestId, FILE_SCROLL_POSITION_BYTES);
}

export function readHandledFileReveal(key: string): number | null {
  return handledFileReveals.get(key);
}

export function fileScrollPositionKey(input: {
  readonly threadKey: string;
  readonly cwd: string;
  readonly relativePath: string;
}): string {
  return `${input.threadKey}\u0000${input.cwd}\u0000${input.relativePath}`;
}

export function readFileScrollPosition(key: string): FileScrollPosition | null {
  return fileScrollPositions.get(key);
}

export function rememberFileScrollPosition(
  key: string,
  scrollTop: number,
  scrollRange: number,
  anchor: {
    readonly surface: FileScrollSurface;
    readonly anchorLine: number | null;
  },
): void {
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollRange) ||
    scrollTop < 0 ||
    scrollRange < 0
  ) {
    return;
  }
  fileScrollPositions.set(
    key,
    {
      scrollTop: Math.min(scrollTop, scrollRange),
      scrollRange,
      surface: anchor.surface,
      anchorLine:
        anchor.anchorLine !== null &&
        Number.isSafeInteger(anchor.anchorLine) &&
        anchor.anchorLine > 0
          ? anchor.anchorLine
          : null,
    },
    FILE_SCROLL_POSITION_BYTES,
  );
}

export function resolveRestoredFileScrollTop(
  position: FileScrollPosition | null,
  nextScrollRange: number,
  target: {
    readonly surface: FileScrollSurface;
    readonly anchorScrollTop: number | null;
  },
): number | null {
  if (!position || !Number.isFinite(nextScrollRange) || nextScrollRange < 0) return null;
  if (
    position.surface !== target.surface &&
    target.anchorScrollTop !== null &&
    Number.isFinite(target.anchorScrollTop)
  ) {
    return Math.min(nextScrollRange, Math.max(0, target.anchorScrollTop));
  }
  if (position.scrollRange === nextScrollRange || position.scrollRange === 0) {
    return Math.min(position.scrollTop, nextScrollRange);
  }
  return Math.min(
    nextScrollRange,
    Math.max(0, (position.scrollTop / position.scrollRange) * nextScrollRange),
  );
}

export function approximateSourceLineScrollTop(
  line: number,
  lineCount: number,
  scrollRange: number,
): number | null {
  if (
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(lineCount) ||
    !Number.isFinite(scrollRange) ||
    line < 1 ||
    lineCount < 1 ||
    scrollRange < 0
  ) {
    return null;
  }
  if (lineCount === 1) return 0;
  return Math.min(scrollRange, ((line - 1) / (lineCount - 1)) * scrollRange);
}

export function clearFileScrollStateForTests(): void {
  fileScrollPositions.clear();
  handledFileReveals.clear();
}
