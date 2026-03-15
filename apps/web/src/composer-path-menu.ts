export function resolveComposerPathMenuEntries<T>(input: {
  query: string;
  isDebouncing: boolean;
  isFetching: boolean;
  isLoading: boolean;
  entries: readonly T[];
}): readonly T[] {
  if (input.query.trim().length === 0) {
    return [];
  }
  if (input.isDebouncing || input.isFetching || input.isLoading) {
    return [];
  }
  return input.entries;
}
