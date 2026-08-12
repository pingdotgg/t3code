type ContextMenuClosedListener = () => void;

const listeners = new Set<ContextMenuClosedListener>();

export function notifyContextMenuClosed() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeContextMenuClosed(listener: ContextMenuClosedListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
