import { type RefObject, useLayoutEffect, useState } from "react";
import { observeResize } from "~/lib/observeResize";

/** A folded tab is the 28px square notch tab showing only its icon. */
export const FOLDED_TAB_CLASS = "size-7 justify-center px-0";
const FOLDED_TAB_WIDTH = 28;
/** Room kept for the overflow menu's 24px trigger until it renders. */
const OVERFLOW_TRIGGER_WIDTH = 24;
/** The active tab truncates down to this before an inactive tab leaves the strip. */
const ACTIVE_TAB_MIN_WIDTH = 140;

export interface PaneTabStripFit {
  /** Inactive tabs show only their icon. */
  readonly folded: boolean;
  /** Inactive tabs that do not fit even folded; they live in the overflow menu. */
  readonly hidden: ReadonlySet<string>;
  /** The active tab does not fit whole: it may shrink and truncate. */
  readonly squeezed: boolean;
}

const UNFOLDED: PaneTabStripFit = { folded: false, hidden: new Set(), squeezed: false };

function sameFit(a: PaneTabStripFit, b: PaneTabStripFit): boolean {
  return (
    a.folded === b.folded &&
    a.squeezed === b.squeezed &&
    a.hidden.size === b.hidden.size &&
    [...a.hidden].every((key) => b.hidden.has(key))
  );
}

/**
 * Measure full tabs before paint; fold inactive labels before truncating the active one.
 * Keep the active label visible and send remaining inactive tabs to overflow, last first.
 */
export function usePaneTabStripFit(
  stripRef: RefObject<HTMLElement | null>,
  tabs: ReadonlyArray<{ readonly key: string; readonly title: string }>,
  activeKey: string | null,
): PaneTabStripFit {
  const signature = JSON.stringify([activeKey, tabs.map((tab) => [tab.key, tab.title])]);
  const [state, setState] = useState<{ signature: string | null; fit: PaneTabStripFit }>({
    signature: null,
    fit: UNFOLDED,
  });
  // Labeled widths, measured in the pass after the signature changes.
  const [widths] = useState(() => new Map<string, number>());
  const measuring = state.signature !== signature;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure tab widths and observe header resizing before choosing overflow tabs.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const notch = strip?.closest<HTMLElement>("[data-pane-notch]");
    const row = notch?.parentElement;
    if (!strip || !notch || !row) return;

    const tabElement = (key: string) =>
      strip.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"]`);
    const measure = (key: string) => {
      const element = tabElement(key);
      if (element) widths.set(key, element.getBoundingClientRect().width);
    };
    const room = () => {
      const rowStyle = getComputedStyle(row);
      let end = row.getBoundingClientRect().right - Number.parseFloat(rowStyle.paddingRight);
      for (let next = notch.nextElementSibling; next; next = next.nextElementSibling) {
        const rect = next.getBoundingClientRect();
        const position = getComputedStyle(next).position;
        if (rect.width === 0 || position === "fixed" || position === "absolute") continue;
        end = rect.left - (Number.parseFloat(rowStyle.columnGap) || 0);
        break;
      }
      return strip.clientWidth + Math.max(0, end - notch.getBoundingClientRect().right);
    };
    const fit = (): PaneTabStripFit => {
      const available = room();
      const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
      const total = (list: ReadonlyArray<number>) =>
        list.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, list.length - 1);
      const labeled = tabs.map((tab) => widths.get(tab.key) ?? FOLDED_TAB_WIDTH);
      if (total(labeled) <= available) return UNFOLDED;
      const folded = tabs.map((tab, index) =>
        tab.key === activeKey ? (labeled[index] ?? 0) : FOLDED_TAB_WIDTH,
      );
      if (total(folded) <= available) return { folded: true, hidden: new Set(), squeezed: false };
      const narrowest = folded.map((width, index) =>
        tabs[index]?.key === activeKey ? Math.min(width, ACTIVE_TAB_MIN_WIDTH) : width,
      );
      if (total(narrowest) <= available) return { folded: true, hidden: new Set(), squeezed: true };
      const trigger =
        strip.querySelector<HTMLElement>("[data-tab-overflow]")?.getBoundingClientRect().width ||
        OVERFLOW_TRIGGER_WIDTH;
      const visible = tabs.map((tab, index) => ({
        key: tab.key,
        width: folded[index] ?? 0,
        narrowest: narrowest[index] ?? 0,
      }));
      const hidden = new Set<string>();
      while (total([...visible.map((tab) => tab.narrowest), trigger]) > available) {
        const lastInactive = visible.findLastIndex((tab) => tab.key !== activeKey);
        if (lastInactive < 0) break;
        hidden.add(visible[lastInactive]!.key);
        visible.splice(lastInactive, 1);
      }
      const squeezed = total([...visible.map((tab) => tab.width), trigger]) > available;
      return { folded: true, hidden, squeezed };
    };
    const apply = () => {
      const next = fit();
      setState((current) =>
        current.signature === signature && sameFit(current.fit, next)
          ? current
          : { signature, fit: next },
      );
    };

    if (measuring) {
      widths.clear();
      for (const tab of tabs) measure(tab.key);
      apply();
      return;
    }

    // The active tab grows after its breadcrumb loads; the room changes with
    // the pane and the header's actions.
    const active = activeKey === null ? null : tabElement(activeKey);
    return observeResize([row, ...row.children, ...(active ? [active] : [])], () => {
      if (activeKey !== null && !state.fit.squeezed) measure(activeKey);
      apply();
    });
  }, [activeKey, measuring, signature, state.fit.squeezed, stripRef, tabs, widths]);

  return measuring ? UNFOLDED : state.fit;
}
