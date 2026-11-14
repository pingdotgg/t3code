export interface SwitcherOpen {
  readonly order: readonly string[];
  readonly highlight: number;
  readonly shown: boolean;
  readonly covered: boolean;
}

export type SwitcherState = SwitcherOpen | null;

export type SwitcherEvent =
  | { type: "tab"; backwards: boolean }
  | { type: "show" }
  | { type: "commit" }
  | { type: "choose"; index: number }
  | { type: "cancel" };

export interface SwitcherResult {
  readonly state: SwitcherState;
  readonly switchTo: string | null;
}

interface OpenOptions {
  readonly backwards: boolean;
  readonly covered: boolean;
  readonly ownCount: number;
}

const closed: SwitcherResult = { state: null, switchTo: null };

export function openSwitcher(order: readonly string[], options: OpenOptions): SwitcherResult {
  if (order.length === 0 || (order.length === 1 && !options.covered)) return closed;
  const highlight = options.covered
    ? 0
    : options.backwards
      ? options.ownCount >= 2
        ? options.ownCount - 1
        : order.length - 1
      : 1;
  return { state: { order, highlight, shown: false, covered: options.covered }, switchTo: null };
}

export function tapTarget(order: readonly string[], options: OpenOptions): string | null {
  const { state } = openSwitcher(order, options);
  return state === null ? null : updateSwitcher(state, { type: "commit" }).switchTo;
}

export function updateSwitcher(state: SwitcherOpen, event: SwitcherEvent): SwitcherResult {
  const count = state.order.length;
  switch (event.type) {
    case "tab": {
      const highlight = state.highlight + (event.backwards ? -1 : 1);
      return {
        state: { ...state, highlight: (highlight + count) % count, shown: true },
        switchTo: null,
      };
    }
    case "show":
      return { state: { ...state, shown: true }, switchTo: null };
    case "commit":
      return choose(state, state.highlight);
    case "choose":
      return choose(state, event.index);
    case "cancel":
      return closed;
  }
}

function choose(state: SwitcherOpen, index: number): SwitcherResult {
  const key = state.order[index];
  if (key === undefined || (index === 0 && !state.covered)) return closed;
  return { state: null, switchTo: key };
}

/** A key-down while the list is open. The list lasts while Ctrl is held, as it was opened. */
export function switcherKeyEvent(
  press: {
    readonly key: string;
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
  },
  opener: { readonly code: string; readonly backwards: boolean },
): SwitcherEvent | null {
  if (press.key === "Escape") return { type: "cancel" };
  // Ctrl's key-up was missed, such as when it was released over another window.
  if (!press.ctrlKey) return { type: "commit" };
  if (press.key === "Tab") return { type: "tab", backwards: press.shiftKey };
  if (press.code === opener.code) return { type: "tab", backwards: opener.backwards };
  if (press.key === "Enter") return { type: "commit" };
  return null;
}
