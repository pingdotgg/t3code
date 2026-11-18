import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { LayoutPane, LayoutTab, LayoutTabGroup, LayoutTabGroupColor } from "./layoutModel";

/** The sidebar section a chat's thread sits in, as far as its tab cares. */
export type PaneStripThreadState = "inbox" | "working" | "settled";

export type PaneStripThread = Parameters<typeof isThreadWorking>[0] &
  ThreadSnoozeShell &
  Pick<EnvironmentThreadShell, "settledOverride">;

export function paneStripThreadRef(tab: LayoutTab): ScopedThreadRef | null {
  return tab.content.kind === "chat" && tab.content.target.kind === "server"
    ? tab.content.target.threadRef
    : null;
}

/** Settled and snoozed win over working, as the sidebar's shelves do. */
export function resolvePaneStripThreadState(
  thread: PaneStripThread,
  now: string,
): PaneStripThreadState {
  if (thread.settledOverride === "settled" || effectiveSnoozed(thread, { now })) return "settled";
  return isThreadWorking(thread) ? "working" : "inbox";
}

/** Each thread's state at `nowMs`, and when the earliest snooze among them ends, if any. */
export function resolvePaneStripThreadStates(
  threads: readonly (PaneStripThread | null)[],
  nowMs: number,
): { states: (PaneStripThreadState | null)[]; wakeAt: number | null } {
  const now = new Date(nowMs).toISOString();
  let wakeAt: number | null = null;
  const states = threads.map((thread) => {
    if (thread === null) return null;
    const until = thread.snoozedUntil == null ? Number.NaN : Date.parse(thread.snoozedUntil);
    if (until > nowMs && (wakeAt === null || until < wakeAt)) wakeAt = until;
    return resolvePaneStripThreadState(thread, now);
  });
  return { states, wakeAt };
}

/**
 * A group as the strip draws it. A stored group (`rule: null`) holds the tabs
 * carrying its id and sits where they are. A rule group holds the pane's other
 * chats whose thread is in the rule's state, and sits at the strip's start.
 */
export interface PaneTabGroupDefinition extends LayoutTabGroup {
  readonly rule: "working" | null;
}

const WORKING_TAB_GROUP_ID = "working";

/** The built-in rule group, on unless Settings turns it off. */
export function workingTabGroup(collapsed: boolean): PaneTabGroupDefinition {
  return { id: WORKING_TAB_GROUP_ID, title: "Working", color: "blue", collapsed, rule: "working" };
}

/** A pane's stored groups, then the Working group when Settings has it on. */
export function paneStripGroups(pane: LayoutPane, workingGroup: boolean): PaneTabGroupDefinition[] {
  const groups: PaneTabGroupDefinition[] = pane.groups.map((group) => ({ ...group, rule: null }));
  if (workingGroup) groups.push(workingTabGroup(pane.workingGroupExpanded !== true));
  return groups;
}

export type PaneStripSegment =
  | { readonly kind: "tab"; readonly tab: LayoutTab }
  | {
      readonly kind: "group";
      readonly group: PaneTabGroupDefinition;
      /** The members drawn: all of them, or while collapsed only the pane's shown tab. */
      readonly tabs: readonly LayoutTab[];
      /** Every member the strip draws while the group is open. */
      readonly count: number;
    };

/**
 * A pane's tab strip in drawing order. A tab joins its stored group, else a rule group its
 * thread matches (not a collapsed one while shown). Settled chats leave the strip when
 * `hideSettled`. The shown tab is always drawn, also inside a collapsed group.
 */
export function arrangePaneStrip(input: {
  readonly tabs: readonly LayoutTab[];
  readonly activeTabId: string | null;
  readonly groups: readonly PaneTabGroupDefinition[];
  readonly threadStateOf: (ref: ScopedThreadRef) => PaneStripThreadState | null;
  readonly hideSettled: boolean;
}): PaneStripSegment[] {
  const stored = new Map(
    input.groups.flatMap((group) => (group.rule === null ? [[group.id, group] as const] : [])),
  );
  const rules = input.groups.filter((group) => group.rule !== null);
  const members = new Map<string, LayoutTab[]>();
  const order: Array<
    | { readonly kind: "tab"; readonly tab: LayoutTab }
    | { readonly kind: "group"; readonly group: PaneTabGroupDefinition }
  > = [];
  for (const tab of input.tabs) {
    const shown = tab.id === input.activeTabId;
    const ref = paneStripThreadRef(tab);
    const state = ref === null ? null : input.threadStateOf(ref);
    if (!shown && input.hideSettled && state === "settled") continue;
    const group =
      (tab.groupId === undefined ? undefined : stored.get(tab.groupId)) ??
      rules.find((rule) => rule.rule === state && !(shown && rule.collapsed));
    if (!group) {
      order.push({ kind: "tab", tab });
      continue;
    }
    const joined = members.get(group.id);
    if (joined) {
      joined.push(tab);
      continue;
    }
    members.set(group.id, [tab]);
    if (group.rule === null) order.push({ kind: "group", group });
  }
  const ruled = rules.flatMap((rule) =>
    members.has(rule.id) ? [{ kind: "group" as const, group: rule }] : [],
  );
  return [...ruled, ...order].map((entry) => {
    if (entry.kind === "tab") return entry;
    const { group } = entry;
    const tabs = members.get(group.id)!;
    return {
      kind: "group",
      group,
      tabs: group.collapsed ? tabs.filter((tab) => tab.id === input.activeTabId) : tabs,
      count: tabs.length,
    };
  });
}

/** The tabs a strip draws, in order: what ctrl+Tab steps through and a close falls back to. */
export function drawnPaneTabIds(segments: readonly PaneStripSegment[]): string[] {
  return segments.flatMap((segment) =>
    segment.kind === "tab" ? [segment.tab.id] : segment.tabs.map((tab) => tab.id),
  );
}

export type PaneStripItem =
  | {
      readonly kind: "tab";
      readonly tab: LayoutTab;
      readonly group: PaneTabGroupDefinition | null;
    }
  | { readonly kind: "chip"; readonly group: PaneTabGroupDefinition; readonly count: number };

/**
 * The strip's items before and after its shown tab, which each pane header draws itself,
 * and the shown tab's group color.
 */
export function splitPaneStrip(
  segments: readonly PaneStripSegment[],
  activeTabId: string,
): { before: PaneStripItem[]; after: PaneStripItem[]; activeColor: LayoutTabGroupColor | null } {
  const before: PaneStripItem[] = [];
  const after: PaneStripItem[] = [];
  let passedActive = false;
  let activeColor: LayoutTabGroupColor | null = null;
  const place = (tab: LayoutTab, group: PaneTabGroupDefinition | null) => {
    if (tab.id !== activeTabId) {
      (passedActive ? after : before).push({ kind: "tab", tab, group });
      return;
    }
    passedActive = true;
    activeColor = group?.color ?? null;
  };
  for (const segment of segments) {
    if (segment.kind === "tab") {
      place(segment.tab, null);
      continue;
    }
    (passedActive ? after : before).push({
      kind: "chip",
      group: segment.group,
      count: segment.count,
    });
    for (const tab of segment.tabs) place(tab, segment.group);
  }
  return { before, after, activeColor };
}

/** A drawn tab and the group it is drawn in, or a group's chip (`id` is then the group's). */
export interface PaneStripDropItem {
  readonly id: string;
  readonly chip?: boolean;
  readonly group?: string;
}

const isWorkingItem = (item: PaneStripDropItem) =>
  (item.chip ? item.id : item.group) === WORKING_TAB_GROUP_ID;

/** Whether the strip draws `tabId` inside its Working group, where a reorder cannot move it. */
export function isDrawnInWorkingGroup(drawn: readonly PaneStripDropItem[], tabId: string): boolean {
  return drawn.some((item) => !item.chip && item.id === tabId && isWorkingItem(item));
}

interface PaneDropInput {
  readonly tabs: readonly LayoutTab[];
  readonly groups: readonly LayoutTabGroup[];
  readonly drawn: readonly PaneStripDropItem[];
}

/**
 * Where a drop lands in the pane's tabs (without the dragged one) just before and just after
 * each drawn item. Working's chip and tabs, and a chip with no tabs left, have neither.
 */
function paneDropSlots({ tabs, groups, drawn }: PaneDropInput) {
  const indexOf = new Map(tabs.map((tab, index) => [tab.id, index]));
  const collapsed = new Set(groups.flatMap((group) => (group.collapsed ? [group.id] : [])));
  const pastGroup = (groupId: string) => tabs.findLastIndex((tab) => tab.groupId === groupId) + 1;
  const groupOf = (item: PaneStripDropItem | undefined) =>
    item === undefined || item.chip ? undefined : tabs[indexOf.get(item.id) ?? -1]?.groupId;
  return drawn.map((item, at) => {
    if (isWorkingItem(item)) return { start: undefined, end: undefined, working: true };
    if (item.chip) {
      const first = tabs.findIndex((tab) => tab.groupId === item.id);
      if (first === -1) return { start: undefined, end: undefined };
      return { start: first, end: collapsed.has(item.id) ? pastGroup(item.id) : first };
    }
    const index = indexOf.get(item.id);
    if (index === undefined) return { start: undefined, end: undefined };
    // Past a group's last drawn tab means past the group, tabs the strip leaves out included.
    const groupId = tabs[index]!.groupId;
    const last = groupId !== undefined && groupOf(drawn[at + 1]) !== groupId;
    return { start: index, end: last ? pastGroup(groupId) : index + 1 };
  });
}

/**
 * A drop's index in the pane's tabs (without the dragged one), from the drawn item it lands
 * before, or past the strip's end when `before` is -1. It lands right after the drawn item to
 * its left, so tabs the strip leaves out stay on the far side, and never inside a collapsed
 * or Working group: a drop on Working lands before the first tab past it.
 */
export function paneDropIndex(input: PaneDropInput & { readonly before: number }): number {
  const slots = paneDropSlots(input);
  const { before } = input;
  if (before === -1 || before >= slots.length) return input.tabs.length;
  const afterPrevious = slots[before - 1]?.end;
  if (afterPrevious !== undefined) return afterPrevious;
  return slots.slice(before).find((slot) => slot.start !== undefined)?.start ?? input.tabs.length;
}

/** The drawn gap a drop resolved to `index` (see `paneDropIndex`) shows its marker at. */
export function paneDropMarker(input: PaneDropInput & { readonly index: number }): number {
  const slots = paneDropSlots(input);
  // A chip with no tabs left sits where the item after it does.
  let start = input.tabs.length;
  let marker = 0;
  for (const slot of slots.toReversed()) {
    start = slot.start ?? start;
    if (slot.working || start < input.index) marker += 1;
  }
  return marker;
}
