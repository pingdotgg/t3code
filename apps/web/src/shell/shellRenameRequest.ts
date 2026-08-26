type Listener = (threadKey: string) => void;

const listeners = new Set<Listener>();

/** A sidebar "Rename" hands the request to whichever view shows that thread. */
export function requestShellRename(threadKey: string): void {
  for (const listener of listeners) listener(threadKey);
}

export function subscribeShellRenameRequests(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
