export interface ProviderReplayGate {
  readonly beforeEmit: (label: string | undefined, signal?: AbortSignal) => Promise<void>;
  readonly waitForReached: (label: string) => Promise<boolean>;
  readonly hasReached: (label: string) => boolean;
  readonly release: (label: string) => boolean;
  readonly releaseAll: () => void;
}

interface GateState {
  reached: boolean;
  released: boolean;
  readonly reachedPromise: Promise<void>;
  readonly resolveReached: () => void;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

export function makeProviderReplayGate(labels: ReadonlyArray<string>): ProviderReplayGate {
  const states = new Map<string, GateState>();
  for (const label of labels) {
    if (states.has(label)) {
      throw new Error(`Duplicate provider replay gate label ${label}.`);
    }
    let resolve = () => {};
    const promise = new Promise<void>((resume) => {
      resolve = resume;
    });
    let resolveReached = () => {};
    const reachedPromise = new Promise<void>((resume) => {
      resolveReached = resume;
    });
    states.set(label, {
      reached: false,
      released: false,
      reachedPromise,
      resolveReached,
      promise,
      resolve,
    });
  }

  return {
    beforeEmit: (label, signal) => {
      if (label === undefined) {
        return Promise.resolve();
      }
      const state = states.get(label);
      if (state === undefined) {
        return Promise.resolve();
      }
      state.reached = true;
      state.resolveReached();
      if (signal === undefined) {
        return state.promise;
      }
      if (signal.aborted) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const stopWaiting = () => resolve();
        signal.addEventListener("abort", stopWaiting, { once: true });
        void state.promise.then(() => {
          signal.removeEventListener("abort", stopWaiting);
          resolve();
        });
      });
    },
    waitForReached: (label) => {
      const state = states.get(label);
      return state === undefined ? Promise.resolve(false) : state.reachedPromise.then(() => true);
    },
    hasReached: (label) => states.get(label)?.reached ?? false,
    release: (label) => {
      const state = states.get(label);
      if (state === undefined || state.released) {
        return false;
      }
      state.released = true;
      state.resolve();
      return true;
    },
    releaseAll: () => {
      for (const state of states.values()) {
        if (state.released) {
          continue;
        }
        state.released = true;
        state.resolve();
      }
    },
  };
}
