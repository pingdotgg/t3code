export interface NativeAppIconState {
  readonly icons: readonly string[];
  readonly selected: string;
}

export interface NativeAppIconModule {
  readonly getState: () => Promise<NativeAppIconState>;
  readonly setIcon: (id: string) => Promise<NativeAppIconState>;
}

/** The OS owns selection. One controller keeps native requests alive across settings navigation. */
export function createAppIconController(native: NativeAppIconModule | null) {
  let state = {
    icons: [] as readonly string[],
    selected: "",
    pending: false,
    error: null as string | null,
  };
  const listeners = new Set<() => void>();
  let generation = 0;
  let changing = false;
  const publish = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    if (!native || changing) return;
    const current = ++generation;
    try {
      const result = await native.getState();
      if (current === generation) publish({ ...result, error: null });
    } catch {
      if (current === generation) publish({ error: "Could not read the app icon. Try again." });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    async select(id: string) {
      if (!native || changing || !state.icons.includes(id) || id === state.selected) return;
      changing = true;
      ++generation;
      publish({ pending: true, error: null });
      try {
        const result = await native.setIcon(id);
        publish({
          ...result,
          error: result.selected === id ? null : "The app icon did not change. Try again.",
        });
      } catch {
        // A native operation can partially succeed. Re-read instead of restoring a guessed selection.
        try {
          publish(await native.getState());
        } catch {
          /* Keep the last confirmed selection. */
        }
        publish({ error: "Could not change the app icon. Try again." });
      } finally {
        changing = false;
        publish({ pending: false });
      }
    },
  };
}
