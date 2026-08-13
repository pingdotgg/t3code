const listeners = new Set<() => void>();

export function notifyTmuxSessionsChanged(): void {
  for (const listener of listeners) listener();
}

export function subscribeTmuxSessionsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
