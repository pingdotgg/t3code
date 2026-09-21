// Shared across hook instances so sidebar, header and menu actions invalidate each other.
const currentActions = new Map<string, symbol>();

/** Claims one kind of thread action; a later claim of that kind expires its Undo. */
export function begin(kind: string, threadKey: string) {
  const key = JSON.stringify([kind, threadKey]);
  const token = Symbol();
  currentActions.set(key, token);
  const isCurrent = () => currentActions.get(key) === token;
  return {
    isCurrent,
    finish: () => {
      if (isCurrent()) currentActions.delete(key);
    },
  };
}

/** Expires only this action kind, leaving unrelated thread actions intact. */
export function invalidate(kind: string, threadKey: string) {
  currentActions.delete(JSON.stringify([kind, threadKey]));
}
