export interface MenuActionInbox {
  readonly deliver: (action: string) => void;
  readonly subscribe: (listener: (action: string) => void) => () => void;
}

/**
 * Buffers menu actions that arrive before the renderer subscribes, so actions
 * triggered while the startup splash is up are replayed once the app mounts.
 */
export function makeMenuActionInbox(): MenuActionInbox {
  const pending: string[] = [];
  let listener: ((action: string) => void) | undefined;

  return {
    deliver: (action) => {
      if (listener === undefined) {
        pending.push(action);
        return;
      }
      listener(action);
    },
    subscribe: (nextListener) => {
      listener = nextListener;
      const replayed = pending.splice(0, pending.length);
      for (const action of replayed) {
        nextListener(action);
      }

      return () => {
        if (listener === nextListener) {
          listener = undefined;
        }
      };
    },
  };
}
