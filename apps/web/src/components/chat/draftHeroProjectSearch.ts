type SearchableProject = {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly searchTerms?: ReadonlyArray<string>;
};

export type DraftHeroProjectPickerState = {
  readonly open: boolean;
  readonly query: string;
};

export type DraftHeroProjectPickerAction =
  | { readonly type: "set-open"; readonly open: boolean }
  | { readonly type: "set-query"; readonly query: string };

export function reduceDraftHeroProjectPickerState(
  state: DraftHeroProjectPickerState,
  action: DraftHeroProjectPickerAction,
): DraftHeroProjectPickerState {
  if (action.type === "set-query") {
    return { ...state, query: action.query };
  }

  return {
    open: action.open,
    query: action.open ? state.query : "",
  };
}

export function isImeCommitKey(input: {
  readonly key: string;
  readonly isComposing: boolean;
  readonly keyCode: number;
}): boolean {
  return input.key === "Enter" && (input.isComposing || input.keyCode === 229);
}

export function filterDraftHeroProjects<T extends SearchableProject>(
  projects: ReadonlyArray<T>,
  query: string,
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return [...projects];
  }

  return projects.filter((project) => {
    const searchText = [project.title, project.workspaceRoot, ...(project.searchTerms ?? [])]
      .join("\n")
      .toLowerCase();
    return tokens.every((token) => searchText.includes(token));
  });
}

export function isVisibleDraftHeroProjectSelection(
  value: string,
  filteredProjectKeys: ReadonlyArray<string>,
): boolean {
  return filteredProjectKeys.includes(value);
}
