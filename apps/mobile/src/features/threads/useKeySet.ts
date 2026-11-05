import { useMemo } from "react";

// Stable key sets keep thread row selection handlers stable across list rebuilds.
export function useKeySet(keys: ReadonlyArray<string>): ReadonlySet<string> {
  const serializedKeys = JSON.stringify([...keys].sort());
  return useMemo(() => new Set(JSON.parse(serializedKeys) as string[]), [serializedKeys]);
}
