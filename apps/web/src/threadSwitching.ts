import type { ClientSettings } from "@t3tools/contracts/settings";

export interface ThreadCyclePreview {
  keys: readonly string[];
  selectedKey: string;
}

export function createThreadSwitcher() {
  let recent: string[] = [];
  let current: string | null = null;
  let cycle: (ThreadCyclePreview & { order: ClientSettings["threadCycleOrder"] }) | null = null;

  const remember = (key: string) => {
    recent = [key, ...recent.filter((entry) => entry !== key)].slice(0, 200);
  };
  return {
    visit(key: string | null) {
      cycle = null;
      current = key;
      if (key !== null) remember(key);
    },
    cancel() {
      cycle = null;
    },
    next(keys: readonly string[], direction: 1 | -1, order: ClientSettings["threadCycleOrder"]) {
      if (cycle?.order !== order) cycle = null;
      const available = new Set(keys);
      if (cycle === null) {
        const ordered = order === "recent" ? [...new Set([...recent, ...keys])] : [...keys];
        cycle = {
          keys: ordered.filter((key) => available.has(key)),
          selectedKey: current ?? "",
          order,
        };
      }
      const index = cycle.keys.indexOf(cycle.selectedKey);
      // Keep the order fixed during a gesture, but skip threads removed while Ctrl is held.
      for (let step = 1; step <= cycle.keys.length; step++) {
        const nextIndex =
          index === -1
            ? direction === 1
              ? step - 1
              : cycle.keys.length - step
            : (index + direction * step + cycle.keys.length) % cycle.keys.length;
        const key = cycle.keys[nextIndex];
        if (key !== undefined && key !== cycle.selectedKey && available.has(key)) {
          cycle = { ...cycle, selectedKey: key };
          return {
            keys: cycle.keys.filter((entry) => available.has(entry)),
            selectedKey: key,
          };
        }
      }
      cycle = null;
      return null;
    },
  };
}

export const threadSwitcher = createThreadSwitcher();
