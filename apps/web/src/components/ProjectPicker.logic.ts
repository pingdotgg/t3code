export interface ProjectPickerFilterItem {
  readonly label: string;
  /** Default and action rows ("All projects", "Add project") that only make sense unfiltered. */
  readonly hideWhileSearching?: boolean | undefined;
}

/**
 * Rows that are not projects head or trail the list while the query is empty
 * and drop out while filtering, so they can't outrank a project match under
 * autoHighlight and no-hit queries reach the empty state.
 */
export function filterProjectPickerItems<TItem extends ProjectPickerFilterItem>(input: {
  items: readonly TItem[];
  query: string;
  matches: (item: TItem, query: string) => boolean;
}): readonly TItem[] {
  const query = input.query.trim();
  if (query.length === 0) return input.items;
  return input.items.filter((item) => !item.hideWhileSearching && input.matches(item, query));
}

export interface ProjectPickerMenuState {
  readonly open: boolean;
  readonly query: string;
}

export type ProjectPickerMenuAction =
  | { readonly type: "query-changed"; readonly query: string }
  | { readonly type: "open-changed"; readonly open: boolean }
  | { readonly type: "project-settings-opened" };

export function reduceProjectPickerMenuState(
  state: ProjectPickerMenuState,
  action: ProjectPickerMenuAction,
): ProjectPickerMenuState {
  switch (action.type) {
    case "query-changed":
      return { ...state, query: action.query };
    case "open-changed":
      return { open: action.open, query: "" };
    case "project-settings-opened":
      return { open: false, query: "" };
  }
}
