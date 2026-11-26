// Fork: what Kaluwa's titlebar tabs add to the keybinding system. Kept free of app state so
// keybindings.ts and the keybindings atom can import it without cycles.
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

let mountedStrips = 0;

/** The tab strip marks itself live while mounted, so its rules only shadow others then. */
export function markKaluwaThreadTabStripMounted(): () => void {
  mountedStrips += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mountedStrips -= 1;
  };
}

/**
 * When-clause identifiers for the tab rules: `kaluwaTabs` while the strip shows, and
 * `kaluwaPanelFocus` while focus is in the right panel, whose own tabs keep Cmd+T and Cmd+W there.
 */
export function kaluwaThreadTabsShortcutContext(): {
  kaluwaTabs: boolean;
  kaluwaPanelFocus: boolean;
} {
  const focused = typeof document === "undefined" ? null : document.activeElement;
  return {
    kaluwaTabs: mountedStrips > 0,
    kaluwaPanelFocus: focused?.closest('[data-workspace-area="panel"]') != null,
  };
}

const isThreadTabRule = (rule: ResolvedKeybindingsConfig[number]) =>
  rule.command.startsWith("threadTab.");

/**
 * The server adds new defaults before a user's existing rules, and the last matching rule wins,
 * so the tab rules move last: while tabs show they win over the Cmd+1–9 thread jumps and the
 * right panel's Cmd+T and Cmd+W.
 */
export function moveThreadTabRulesLast(
  rules: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (!rules.some(isThreadTabRule)) return rules;
  return [...rules.filter((rule) => !isThreadTabRule(rule)), ...rules.filter(isThreadTabRule)];
}
