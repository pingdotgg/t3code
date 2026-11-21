/**
 * What is open beside a run: agent transcripts and the things the run touched, one tab each. It
 * lives in the address, so a reload or a shared link opens the same tabs.
 */
export type WorkflowPaneTab =
  /** An agent's thread, and the linked environment it is in when not the run's own. */
  | { readonly thread: string; readonly env?: string }
  /** One of the run's references, by its kind and key. */
  | { readonly kind: string; readonly key: string };

export interface WorkflowPaneState {
  readonly pane?: ReadonlyArray<WorkflowPaneTab>;
  /** Which tab shows; the last one when it names none. */
  readonly tab?: number;
}

// A link is typed into an address bar: what it holds is capped like the rest of the address.
const MOST_TABS = 12;
const LONGEST = 400;

const text = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && value.length <= LONGEST;

function readTab(raw: unknown): WorkflowPaneTab | null {
  if (typeof raw !== "object" || raw === null) return null;
  const fields = raw as Readonly<Record<string, unknown>>;
  if (text(fields.thread)) {
    return text(fields.env)
      ? { thread: fields.thread, env: fields.env }
      : { thread: fields.thread };
  }
  return text(fields.kind) && text(fields.key) ? { kind: fields.kind, key: fields.key } : null;
}

const sameWorkflowPaneTab = (left: WorkflowPaneTab, right: WorkflowPaneTab) =>
  "thread" in left
    ? "thread" in right && left.thread === right.thread && left.env === right.env
    : "kind" in right && left.kind === right.kind && left.key === right.key;

/** The pane an address names, without what it cannot read or holds twice. */
export function readWorkflowPane(rawPane: unknown, rawTab: unknown): WorkflowPaneState {
  const tabs: Array<WorkflowPaneTab> = [];
  for (const raw of Array.isArray(rawPane) ? rawPane : []) {
    const tab = readTab(raw);
    if (tab === null || tabs.some((open) => sameWorkflowPaneTab(open, tab))) continue;
    tabs.push(tab);
    if (tabs.length === MOST_TABS) break;
  }
  if (tabs.length === 0) return {};
  const tab = typeof rawTab === "number" ? rawTab : Number(rawTab);
  return Number.isInteger(tab) && tab >= 0 && tab < tabs.length - 1
    ? { pane: tabs, tab }
    : { pane: tabs };
}

/** The index of the tab that shows, or -1 when nothing is open. */
export function activeWorkflowPaneIndex(state: WorkflowPaneState): number {
  const count = state.pane?.length ?? 0;
  return state.tab !== undefined && state.tab < count ? state.tab : count - 1;
}

export function activeWorkflowPaneTab(state: WorkflowPaneState): WorkflowPaneTab | null {
  return state.pane?.[activeWorkflowPaneIndex(state)] ?? null;
}

const stateOf = (tabs: ReadonlyArray<WorkflowPaneTab>, active: number): WorkflowPaneState =>
  tabs.length === 0
    ? {}
    : active === tabs.length - 1
      ? { pane: tabs }
      : { pane: tabs, tab: active };

/** Shows `tab`, opening it after the others when it is not open yet. */
export function openWorkflowPaneTab(
  state: WorkflowPaneState,
  tab: WorkflowPaneTab,
): WorkflowPaneState {
  const tabs = state.pane ?? [];
  const at = tabs.findIndex((open) => sameWorkflowPaneTab(open, tab));
  if (at !== -1) return stateOf(tabs, at);
  const next = [...tabs, tab].slice(-MOST_TABS);
  return stateOf(next, next.length - 1);
}

/** Closes the tab at `index`. The one beside it shows if it was showing. */
export function closeWorkflowPaneTab(state: WorkflowPaneState, index: number): WorkflowPaneState {
  const tabs = state.pane ?? [];
  if (index < 0 || index >= tabs.length) return state;
  const active = activeWorkflowPaneIndex(state);
  const rest = tabs.filter((_, at) => at !== index);
  return stateOf(rest, active > index ? active - 1 : Math.min(active, rest.length - 1));
}

/** Asking for the tab that shows closes it, as the pressed control that asked says it will. */
export function toggleWorkflowPaneTab(
  state: WorkflowPaneState,
  tab: WorkflowPaneTab,
): WorkflowPaneState {
  const active = activeWorkflowPaneTab(state);
  return active !== null && sameWorkflowPaneTab(active, tab)
    ? closeWorkflowPaneTab(state, activeWorkflowPaneIndex(state))
    : openWorkflowPaneTab(state, tab);
}
