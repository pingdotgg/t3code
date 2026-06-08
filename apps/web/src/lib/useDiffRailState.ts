import { useCallback, useEffect, useState } from "react";

const RAIL_STORAGE_KEY = "t3code:diff-rail:v1";
const DEFAULT_RAIL_SIZE = 26;
const MIN_RAIL_SIZE = 12;
const MAX_RAIL_SIZE = 65;

interface DiffRailState {
  size: number;
  collapsed: boolean;
}

function clampRailSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_RAIL_SIZE;
  return Math.min(MAX_RAIL_SIZE, Math.max(MIN_RAIL_SIZE, size));
}

function readPersistedRailState(): DiffRailState {
  if (typeof window === "undefined") {
    return { size: DEFAULT_RAIL_SIZE, collapsed: false };
  }
  try {
    const raw = window.localStorage.getItem(RAIL_STORAGE_KEY);
    if (!raw) {
      return { size: DEFAULT_RAIL_SIZE, collapsed: false };
    }
    const parsed = JSON.parse(raw) as Partial<DiffRailState>;
    return {
      size: clampRailSize(typeof parsed.size === "number" ? parsed.size : DEFAULT_RAIL_SIZE),
      collapsed: Boolean(parsed.collapsed),
    };
  } catch {
    return { size: DEFAULT_RAIL_SIZE, collapsed: false };
  }
}

/**
 * Persists the diff navigation rail's width and collapsed state in
 * localStorage, independent of the per-thread `panelLayoutStore` (this is a
 * global preference for the diff surface, not a per-thread layout concern).
 */
export function useDiffRailState() {
  const [state, setState] = useState<DiffRailState>(() => readPersistedRailState());

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(RAIL_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore persistence failures (e.g. storage disabled / quota).
    }
  }, [state]);

  const setRailSize = useCallback((size: number) => {
    setState((current) => {
      const next = clampRailSize(size);
      return current.size === next ? current : { ...current, size: next };
    });
  }, []);

  const setRailCollapsed = useCallback((collapsed: boolean) => {
    setState((current) => (current.collapsed === collapsed ? current : { ...current, collapsed }));
  }, []);

  const toggleRailCollapsed = useCallback(() => {
    setState((current) => ({ ...current, collapsed: !current.collapsed }));
  }, []);

  return {
    railSize: state.size,
    railCollapsed: state.collapsed,
    setRailSize,
    setRailCollapsed,
    toggleRailCollapsed,
    defaultRailSize: DEFAULT_RAIL_SIZE,
    minRailSize: MIN_RAIL_SIZE,
    maxRailSize: MAX_RAIL_SIZE,
  };
}
