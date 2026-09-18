/**
 * Shared `@pierre/diffs` plumbing for the lazy-loaded code/diff views.
 *
 * IMPORTANT: this module (transitively) pulls in the whole diffs+shiki
 * runtime. Only `React.lazy` chunks (`pages/Commit.tsx`,
 * `pages/FileView.tsx`) may import it — never `main.tsx`/`Repo.tsx`
 * statically — so the library stays out of the initial bundle.
 *
 * Reference equality is the library's re-render contract: every
 * `options`/`file`/`fileDiff` object handed to a component must be
 * memoized (the hooks below key their `useMemo` on the resolved theme).
 * `themeType` is always pinned to our toggle — the components render
 * into a shadow root that would otherwise follow the OS, not the app's
 * `.dark` class.
 */
import type { FileDiffOptions, FileOptions } from "@pierre/diffs";
import { useMemo } from "react";
import { useTheme } from "./theme.tsx";

/** Shiki theme pair matching the app palette (see `useDiffThemeOptions`). */
export const DIFF_THEMES = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;

/** Memoized options for `<FileDiff>`: unified view, app-owned header. */
export const useFileDiffOptions = (): FileDiffOptions<undefined, undefined> => {
  const { resolved } = useTheme();
  return useMemo(
    () => ({
      theme: DIFF_THEMES,
      themeType: resolved,
      diffStyle: "unified",
      disableFileHeader: true,
    }),
    [resolved],
  );
};

/** Memoized options for `<File>` (plain blob view, app-owned header). */
export const useFileOptions = (): FileOptions<undefined, undefined> => {
  const { resolved } = useTheme();
  return useMemo(
    () => ({
      theme: DIFF_THEMES,
      themeType: resolved,
      disableFileHeader: true,
    }),
    [resolved],
  );
};

/** Blobs bigger than this are never fetched/rendered as text diffs. */
export const MAX_RENDER_BYTES = 1024 * 1024;

/** Plain promise concurrency limiter (the SPA ships no Effect runtime). */
export const makeLimiter = (max: number) => {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return <T,>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task().then(resolve, reject).finally(release);
      };
      if (active < max) run();
      else queue.push(run);
    });
};

/** App-wide cap on concurrent blob fetches from the diff views. */
export const blobLimiter = makeLimiter(4);
