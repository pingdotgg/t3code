import type { EnvironmentId, IssueProviderKind, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

export const MAX_SELECTED_WORK_ITEMS = 20;

export interface SelectedWorkItem {
  readonly kind: "issue" | "pull-request";
  readonly provider: IssueProviderKind;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

type SelectionError = "project" | "limit" | null;

const keyOf = (item: SelectedWorkItem) =>
  `${item.kind}:${item.provider}:${item.environmentId}:${item.projectId}:${item.repository}:${item.number}`;

export function addWorkItem(
  items: ReadonlyArray<SelectedWorkItem>,
  item: SelectedWorkItem,
): { readonly items: ReadonlyArray<SelectedWorkItem>; readonly error: SelectionError } {
  if (
    items.some(
      (selected) =>
        selected.environmentId !== item.environmentId || selected.projectId !== item.projectId,
    )
  ) {
    return { items, error: "project" };
  }
  if (items.length >= MAX_SELECTED_WORK_ITEMS) return { items, error: "limit" };
  return { items: [...items, item], error: null };
}

interface WorkItemSelectionState {
  readonly selecting: boolean;
  readonly mode: "compound" | "subtasks";
  readonly items: ReadonlyArray<SelectedWorkItem>;
  readonly start: () => void;
  readonly clear: () => void;
  readonly setMode: (mode: "compound" | "subtasks") => void;
  readonly toggle: (item: SelectedWorkItem) => SelectionError;
}

export const useWorkItemSelection = create<WorkItemSelectionState>((set, get) => ({
  selecting: false,
  mode: "compound",
  items: [],
  start: () => set({ selecting: true }),
  clear: () => set({ selecting: false, items: [] }),
  setMode: (mode) => set({ mode }),
  toggle: (item) => {
    const items = get().items;
    const key = keyOf(item);
    if (items.some((selected) => keyOf(selected) === key)) {
      const remaining = items.filter((selected) => keyOf(selected) !== key);
      set({ selecting: remaining.length > 0, items: remaining });
      return null;
    }
    const next = addWorkItem(items, item);
    if (next.error === null) set({ selecting: true, items: next.items });
    return next.error;
  },
}));

export const isWorkItemSelected = (
  items: ReadonlyArray<SelectedWorkItem>,
  item: SelectedWorkItem,
) => items.some((selected) => keyOf(selected) === keyOf(item));
