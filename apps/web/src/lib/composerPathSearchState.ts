import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";

const COMPOSER_PATH_SEARCH_DEBOUNCE_MS = 120;
const COMPOSER_PATH_SEARCH_LIMIT = 80;

/**
 * Multi-repo workspaces (#923): a path-search target can span several repo
 * roots. When `roots` is set the server unions those roots and tags each
 * entry with the owning `root`; single-root projects pass only `cwd`.
 */
export interface ComposerPathSearchTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly roots?: ReadonlyArray<string> | null;
  readonly query: string | null;
}

export interface ComposerPathSearchEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  /** Path of the entry's parent directory, when reported by the server. */
  readonly parentPath?: string | undefined;
  /** Owning repo root (multi-repo, #923); omitted in single-root mode. */
  readonly root?: string | undefined;
}

export interface ComposerPathSearchState {
  readonly entries: ReadonlyArray<ComposerPathSearchEntry>;
  readonly error: string | null;
  readonly isPending: boolean;
}

export function areComposerPathSearchTargetsEqual(
  left: ComposerPathSearchTarget,
  right: ComposerPathSearchTarget,
): boolean {
  const leftRoots = left.roots ?? [];
  const rightRoots = right.roots ?? [];
  return (
    left.environmentId === right.environmentId &&
    left.cwd === right.cwd &&
    (left.query?.trim() ?? "") === (right.query?.trim() ?? "") &&
    leftRoots.length === rightRoots.length &&
    leftRoots.every((root, index) => root === rightRoots[index])
  );
}

export function composerPathSearchEntryDescription(
  entry: ComposerPathSearchEntry,
  rootLabel?: string,
): string {
  const parentPath =
    entry.parentPath ?? entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
  if (!entry.root) return parentPath;
  return `${rootLabel ?? entry.root}/${parentPath}`.replace(/\/$/, "");
}

function useDebouncedValue<A>(value: A, delayMs: number): A {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [delayMs, value]);

  return debounced;
}

export function useComposerPathSearch(target: ComposerPathSearchTarget): ComposerPathSearchState {
  // Stable dep for the roots array: newline-joined (paths never contain "\n").
  const rootsKey = target.roots && target.roots.length > 0 ? target.roots.join("\n") : "";
  const normalizedTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      roots: rootsKey ? rootsKey.split("\n") : null,
      query: target.query?.trim() ?? "",
    }),
    [rootsKey, target.cwd, target.environmentId, target.query],
  );
  const debouncedTarget = useDebouncedValue(normalizedTarget, COMPOSER_PATH_SEARCH_DEBOUNCE_MS);

  const result = useEnvironmentQuery(
    debouncedTarget.environmentId !== null &&
      debouncedTarget.cwd !== null &&
      debouncedTarget.query.length > 0
      ? projectEnvironment.searchEntries({
          environmentId: debouncedTarget.environmentId,
          input: {
            cwd: debouncedTarget.cwd,
            // Only send `roots` when more than the implicit single root is
            // present, so single-repo projects keep the legacy single-root path.
            ...(debouncedTarget.roots && debouncedTarget.roots.length > 0
              ? { roots: debouncedTarget.roots }
              : {}),
            query: debouncedTarget.query,
            limit: COMPOSER_PATH_SEARCH_LIMIT,
          },
        })
      : null,
  );

  const entries = useMemo<ReadonlyArray<ComposerPathSearchEntry>>(
    () =>
      (result.data?.entries ?? []).map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        ...(entry.parentPath !== undefined ? { parentPath: entry.parentPath } : {}),
        // Tag results by owning root so the composer can disambiguate same-named
        // files across repos and resolve previews against the right repo (#923).
        ...(entry.root !== undefined ? { root: entry.root } : {}),
      })),
    [result.data],
  );
  const targetIsCurrent = areComposerPathSearchTargetsEqual(normalizedTarget, debouncedTarget);

  return {
    entries: targetIsCurrent ? entries : [],
    error: targetIsCurrent ? result.error : null,
    isPending: !targetIsCurrent || (debouncedTarget.query.length > 0 && result.isPending),
  };
}
