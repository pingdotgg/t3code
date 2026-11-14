import { create } from "zustand";

/**
 * The folder a new thread was started in, keyed by its scoped thread key, from the moment its
 * draft opens until the server holds the thread's tag. Session-only: a reload drops it.
 */
export const useNewThreadFolderStore = create<{
  readonly tagByThreadKey: Readonly<Record<string, string>>;
}>(() => ({ tagByThreadKey: {} }));

export function setNewThreadFolder(threadKey: string, tag: string | null): void {
  useNewThreadFolderStore.setState(({ tagByThreadKey }) => {
    if ((tagByThreadKey[threadKey] ?? null) === tag) return {};
    const { [threadKey]: _previous, ...rest } = tagByThreadKey;
    return { tagByThreadKey: tag === null ? rest : { ...rest, [threadKey]: tag } };
  });
}

export function readNewThreadFolder(threadKey: string): string | null {
  return useNewThreadFolderStore.getState().tagByThreadKey[threadKey] ?? null;
}
