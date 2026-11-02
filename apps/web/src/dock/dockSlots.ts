import { create } from "zustand";

export interface DockGroupSlots {
  readonly tabs: HTMLElement | null;
  readonly body: HTMLElement | null;
}

const EMPTY_SLOTS: DockGroupSlots = { tabs: null, body: null };

/** The live DOM of each dock group, so whoever owns a tab's content can render into it. */
export const useDockSlotStore = create<{
  readonly slots: Readonly<Record<string, DockGroupSlots>>;
  /** For chrome that belongs to the window, which must outlive any one tab being on show. */
  readonly root: HTMLElement | null;
}>(() => ({ slots: {}, root: null }));

export function setDockSlot(
  groupId: string,
  name: keyof DockGroupSlots,
  element: HTMLElement | null,
) {
  useDockSlotStore.setState(({ slots }) => ({
    slots: { ...slots, [groupId]: { ...(slots[groupId] ?? EMPTY_SLOTS), [name]: element } },
  }));
}

export function useDockGroupSlots(groupId: string | null): DockGroupSlots {
  return useDockSlotStore((state) => (groupId && state.slots[groupId]) || EMPTY_SLOTS);
}
