export interface ModelPickerSubProviderGroup<T> {
  readonly subProvider: string;
  readonly models: ReadonlyArray<T>;
}

/**
 * Splits one instance's models into sub-provider groups sorted by name. Pinned models and models
 * with no sub-provider stay above the groups in their given order. Returns null under two
 * sub-providers, so a single-catalog provider keeps its flat list.
 */
export function groupModelsBySubProvider<T extends { readonly subProvider?: string }>(
  models: ReadonlyArray<T>,
  isPinned: (model: T) => boolean,
): {
  readonly pinned: ReadonlyArray<T>;
  readonly groups: ReadonlyArray<ModelPickerSubProviderGroup<T>>;
} | null {
  if (new Set(models.flatMap((model) => model.subProvider ?? [])).size < 2) {
    return null;
  }
  const pinned: T[] = [];
  const modelsBySubProvider = new Map<string, T[]>();
  for (const model of models) {
    if (model.subProvider === undefined || isPinned(model)) {
      pinned.push(model);
      continue;
    }
    const group = modelsBySubProvider.get(model.subProvider);
    if (group) {
      group.push(model);
    } else {
      modelsBySubProvider.set(model.subProvider, [model]);
    }
  }
  return {
    pinned,
    groups: [...modelsBySubProvider]
      .map(([subProvider, groupModels]) => ({ subProvider, models: groupModels }))
      .toSorted((a, b) => a.subProvider.localeCompare(b.subProvider)),
  };
}
