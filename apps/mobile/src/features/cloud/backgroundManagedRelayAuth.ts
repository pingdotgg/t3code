import { getClerkInstance } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";

import { acquireBackgroundManagedRelaySession } from "./managedRelaySessionOwnership";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "./publicConfig";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export type BackgroundManagedRelayAuthState =
  | { readonly status: "active"; readonly accountId: string }
  | { readonly status: "signed-out" }
  | { readonly status: "unconfigured" }
  | { readonly status: "superseded" }
  | { readonly status: "retrying"; readonly error: unknown };

interface BackgroundClerkSession {
  readonly user: { readonly id: string };
  readonly getToken: (
    options: ReturnType<typeof resolveRelayClerkTokenOptions>,
  ) => Promise<string | null>;
}

interface BackgroundClerk {
  readonly loaded: boolean;
  readonly session: BackgroundClerkSession | null | undefined;
  readonly load: () => Promise<void>;
}

interface BackgroundManagedRelayAuthDependencies {
  readonly resolveConfig: typeof resolveCloudPublicConfig;
  readonly createClerk: (publishableKey: string) => BackgroundClerk;
  readonly resolveTokenOptions: typeof resolveRelayClerkTokenOptions;
  readonly acquireSession: typeof acquireBackgroundManagedRelaySession;
}

interface BackgroundManagedRelayAuthAttempt {
  readonly state: BackgroundManagedRelayAuthState;
  readonly release?: () => void;
}

const defaultDependencies: BackgroundManagedRelayAuthDependencies = {
  resolveConfig: resolveCloudPublicConfig,
  createClerk: (publishableKey) => getClerkInstance({ publishableKey, tokenCache }),
  resolveTokenOptions: resolveRelayClerkTokenOptions,
  acquireSession: acquireBackgroundManagedRelaySession,
};

let authenticationEpoch = 0;

/** Prevent an in-flight Clerk load from restoring ownership after sign-out. */
export function invalidateBackgroundManagedRelayAuth(): void {
  authenticationEpoch += 1;
}

export async function bootstrapBackgroundManagedRelayAuth(
  dependencies: BackgroundManagedRelayAuthDependencies = defaultDependencies,
): Promise<BackgroundManagedRelayAuthAttempt> {
  const attemptEpoch = authenticationEpoch;
  try {
    const config = dependencies.resolveConfig();
    if (!config.clerk.publishableKey || !config.clerk.jwtTemplate || !config.relay.url) {
      return { state: { status: "unconfigured" } };
    }

    const clerk = dependencies.createClerk(config.clerk.publishableKey);
    if (!clerk.loaded) {
      await clerk.load();
    }
    const session = clerk.session;
    if (!session?.user.id) {
      return { state: { status: "signed-out" } };
    }

    // Clerk loading crosses an async boundary. Sign-out or account switching
    // can invalidate this result while it is in flight; never let that stale
    // account reacquire the background owner after ownership was cleared.
    if (attemptEpoch !== authenticationEpoch) {
      return { state: { status: "superseded" } };
    }

    const release = dependencies.acquireSession({
      accountId: session.user.id,
      readClerkToken: () => session.getToken(dependencies.resolveTokenOptions()),
    });
    if (release === null) {
      return { state: { status: "superseded" } };
    }
    return {
      state: { status: "active", accountId: session.user.id },
      release,
    };
  } catch (error) {
    return { state: { status: "retrying", error } };
  }
}

interface BackgroundManagedRelayAuthControllerOptions {
  readonly bootstrap?: () => Promise<BackgroundManagedRelayAuthAttempt>;
  readonly scheduleRetry?: (retry: () => void, delayMs: number) => () => void;
  readonly onStateChange?: (state: BackgroundManagedRelayAuthState) => void;
}

export interface BackgroundManagedRelayAuthController {
  readonly firstAttempt: Promise<BackgroundManagedRelayAuthState>;
  readonly retryNow: () => Promise<BackgroundManagedRelayAuthState>;
  readonly stop: () => void;
}

const backgroundManagedRelayAuthRefreshers = new Set<
  () => Promise<BackgroundManagedRelayAuthState>
>();

export async function refreshBackgroundManagedRelayAuth(): Promise<void> {
  await Promise.all([...backgroundManagedRelayAuthRefreshers].map((refresh) => refresh()));
}

function defaultScheduleRetry(retry: () => void, delayMs: number): () => void {
  const timeout = setTimeout(retry, delayMs);
  return () => clearTimeout(timeout);
}

export function startBackgroundManagedRelayAuth(
  options: BackgroundManagedRelayAuthControllerOptions = {},
): BackgroundManagedRelayAuthController {
  const bootstrap = options.bootstrap ?? (() => bootstrapBackgroundManagedRelayAuth());
  const scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry;
  let stopped = false;
  let failureCount = 0;
  let releaseSession: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;
  let inFlight: Promise<BackgroundManagedRelayAuthState> | null = null;
  let refreshRequested = false;

  const cancelScheduledRetry = () => {
    cancelRetry?.();
    cancelRetry = null;
  };

  const runAttempt = (): Promise<BackgroundManagedRelayAuthState> => {
    if (inFlight) {
      return inFlight;
    }
    cancelScheduledRetry();
    const operation = (async () => {
      const attempt = await bootstrap().catch(
        (error): BackgroundManagedRelayAuthAttempt => ({
          state: { status: "retrying", error },
        }),
      );
      if (stopped) {
        attempt.release?.();
        return attempt.state;
      }

      if (attempt.state.status === "active") {
        failureCount = 0;
        const previousRelease = releaseSession;
        releaseSession = attempt.release ?? null;
        previousRelease?.();
      } else if (attempt.state.status === "retrying") {
        const retryDelay = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** failureCount, MAX_RETRY_DELAY_MS);
        failureCount += 1;
        cancelRetry = scheduleRetry(() => {
          cancelRetry = null;
          void runAttempt();
        }, retryDelay);
      } else {
        releaseSession?.();
        releaseSession = null;
      }

      options.onStateChange?.(attempt.state);
      return attempt.state;
    })();
    const trackedOperation = operation.finally(() => {
      if (inFlight === trackedOperation) {
        inFlight = null;
      }
    });
    inFlight = trackedOperation;
    return trackedOperation;
  };

  const requestAttempt = (): Promise<BackgroundManagedRelayAuthState> => {
    const currentAttempt = inFlight;
    if (currentAttempt === null) {
      return runAttempt();
    }
    // Coalesce refreshes, but guarantee one fresh bootstrap after the current
    // attempt. Returning the in-flight promise alone would let a sign-out
    // invalidation be consumed by the stale attempt without rereading Clerk.
    refreshRequested = true;
    return currentAttempt.then((state) => {
      if (stopped || !refreshRequested) {
        return state;
      }
      refreshRequested = false;
      return runAttempt();
    });
  };

  backgroundManagedRelayAuthRefreshers.add(requestAttempt);
  const firstAttempt = runAttempt();
  return {
    firstAttempt,
    retryNow: requestAttempt,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      backgroundManagedRelayAuthRefreshers.delete(requestAttempt);
      cancelScheduledRetry();
      releaseSession?.();
      releaseSession = null;
    },
  };
}
