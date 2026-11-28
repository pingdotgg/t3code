import { createContext } from "react";

/** Names the open workspace file per environment and thread, so viewers outlive remounts. */
export const PreviewPositionKey = createContext<string | null>(null);

export function previewPositionKey(
  ...parts: readonly [environmentId: string, threadId: string, cwd: string, path: string]
): string {
  return JSON.stringify(parts);
}

/** Reading positions outlive the preview, which unmounts when the file or thread changes. */
export function createPositionMemory<T>(limit = 100) {
  const positions = new Map<string, T>();
  return {
    get: (key: string | null) => (key === null ? undefined : positions.get(key)),
    set(key: string | null, position: T) {
      if (key === null) return;
      positions.delete(key);
      positions.set(key, position);
      const oldest = positions.keys().next();
      if (positions.size > limit && !oldest.done) positions.delete(oldest.value);
    },
  };
}
