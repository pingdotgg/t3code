import { useSyncLayout } from "@legendapp/list/react-native";
import { useLayoutEffect, useRef } from "react";

const unset = Symbol("unset");

/**
 * Re-measures the enclosing list row in the commit where `key` changes. Legend List otherwise
 * learns about growth from a row's own state through a native layout event, which a busy JS
 * thread delivers late, and until then the row draws over the one below it.
 */
export function useSyncListLayoutOnChange(key: unknown) {
  const syncLayout = useSyncLayout();
  const previous = useRef<unknown>(unset);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells Legend List, an external layout system, about this row's new size in the same commit
  useLayoutEffect(() => {
    if (Object.is(previous.current, key)) return;
    previous.current = key;
    syncLayout();
  }, [key, syncLayout]);
}
