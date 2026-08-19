export const CLERK_LOAD_TIMEOUT_MS = 12_000;
export const CLERK_LOAD_MAX_AUTO_REMOUNTS = 3;

export interface ClerkLoadRecoveryState {
  readonly autoRemountCount: number;
  readonly generation: number;
  readonly timedOut: boolean;
}

export const initialClerkLoadRecoveryState: ClerkLoadRecoveryState = {
  autoRemountCount: 0,
  generation: 0,
  timedOut: false,
};

export type ClerkLoadRecoveryEvent =
  | { readonly type: "loaded" }
  | { readonly type: "manual-remount" }
  | {
      readonly type: "timeout";
      readonly isActive: boolean;
      readonly isLoaded: boolean;
    };

export function shouldMarkClerkLoadTimedOut(input: {
  readonly autoRemountCount: number;
  readonly elapsedMs: number;
  readonly isActive: boolean;
  readonly isLoaded: boolean;
}): boolean {
  return (
    !input.isLoaded &&
    input.isActive &&
    input.elapsedMs >= CLERK_LOAD_TIMEOUT_MS &&
    input.autoRemountCount >= CLERK_LOAD_MAX_AUTO_REMOUNTS
  );
}

export function shouldAutoRemountClerk(input: {
  readonly autoRemountCount: number;
  readonly elapsedMs: number;
  readonly isActive: boolean;
  readonly isLoaded: boolean;
}): boolean {
  return (
    !input.isLoaded &&
    input.isActive &&
    input.elapsedMs >= CLERK_LOAD_TIMEOUT_MS &&
    input.autoRemountCount < CLERK_LOAD_MAX_AUTO_REMOUNTS
  );
}

export function reduceClerkLoadRecovery(
  state: ClerkLoadRecoveryState,
  event: ClerkLoadRecoveryEvent,
): ClerkLoadRecoveryState {
  switch (event.type) {
    case "loaded":
      if (state.autoRemountCount === 0 && !state.timedOut) {
        return state;
      }
      return {
        autoRemountCount: 0,
        generation: state.generation,
        timedOut: false,
      };
    case "manual-remount":
      return {
        ...state,
        generation: state.generation + 1,
        timedOut: false,
      };
    case "timeout": {
      const input = {
        autoRemountCount: state.autoRemountCount,
        elapsedMs: CLERK_LOAD_TIMEOUT_MS,
        isActive: event.isActive,
        isLoaded: event.isLoaded,
      };
      if (shouldAutoRemountClerk(input)) {
        return {
          autoRemountCount: state.autoRemountCount + 1,
          generation: state.generation + 1,
          timedOut: false,
        };
      }
      if (shouldMarkClerkLoadTimedOut(input) && !state.timedOut) {
        return {
          ...state,
          timedOut: true,
        };
      }
      return state;
    }
  }
}

export function clerkAccountRowLabel(input: {
  readonly email: string | undefined;
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly loadTimedOut: boolean;
}): string {
  if (!input.isLoaded) {
    return input.loadTimedOut ? "Retry" : "Checking";
  }
  if (!input.isSignedIn) {
    return "Sign in";
  }
  return input.email ?? "Signed in";
}
