import { useEffect, useState } from "react";

/**
 * Every tab the reader has opened stays mounted behind the active one, so returning to one is not
 * a rebuild: a long description and a long conversation both re-parse their whole markdown, and a
 * diff virtualizes against its own scroll position. The caller hides the inactive ones with
 * `visibility`, which keeps boxes, sizes and scroll offsets.
 */
export function useMountedTabs<Tab extends string>(tab: Tab): ReadonlySet<Tab> {
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<Tab>>(() => new Set<Tab>([tab]));
  useEffect(() => {
    setMountedTabs((previous) => (previous.has(tab) ? previous : new Set<Tab>(previous).add(tab)));
  }, [tab]);
  return mountedTabs;
}
