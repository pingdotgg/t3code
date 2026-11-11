import { createContext, useState } from "react";
import {
  collectThreadFilePaths,
  createThreadFilePathIndex,
  type ThreadFilePathIndex,
  type ThreadFilePathItem,
} from "@t3tools/shared/threadFilePaths";

export const ThreadFilePathsContext = createContext<ThreadFilePathIndex | null>(null);

export function useThreadFilePathIndex(
  items: ReadonlyArray<ThreadFilePathItem>,
  cwd: string | null,
) {
  const paths = collectThreadFilePaths(items, cwd);
  const key = JSON.stringify(paths);
  const [indexed, setIndexed] = useState(() => ({ key, index: createThreadFilePathIndex(paths) }));
  if (indexed.key !== key) {
    const next = { key, index: createThreadFilePathIndex(paths) };
    setIndexed(next);
    return next.index;
  }
  return indexed.index;
}
