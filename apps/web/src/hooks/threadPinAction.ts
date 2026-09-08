// Shared across hook instances so sidebar, header and menu actions invalidate each other.
const currentActions = new Map<string, symbol>();

export function begin(key: string) {
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
