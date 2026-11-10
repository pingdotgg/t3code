import { reportAtomCommandResult, settlePromise } from "../state/runtime.ts";

/**
 * The slice of a Clerk instance the account service needs. Clerk emits on
 * every resource change (token refreshes, profile edits), so the service
 * dedupes emissions down to account changes.
 */
export interface CloudAccountSource {
  readonly addListener: (
    listener: (resources: { readonly user?: { readonly id: string } | null | undefined }) => void,
  ) => () => void;
}

interface CloudAccountSignIn {
  readonly _tag: "SignIn";
  readonly accountId: string;
  /** Signed-in account being replaced; its data is removed before activation. */
  readonly switchFromAccountId: string | null;
  readonly isAccountTransition: boolean;
}

export type CloudAccountStep =
  | { readonly _tag: "None" }
  | {
      readonly _tag: "SignOut";
      /** Account whose data is removed; null removes data of any account. */
      readonly previousAccountId: string | null;
      readonly isAccountTransition: boolean;
    }
  | CloudAccountSignIn;

/**
 * `previous` is undefined until Clerk's first emission. A first emission that
 * is signed out still cleans up, so data left by an account that signed out
 * while the app was closed does not linger.
 */
export function planCloudAccountStep(
  previous: string | null | undefined,
  next: string | null,
): CloudAccountStep {
  if (previous === next) return { _tag: "None" };
  const isAccountTransition = previous !== undefined;
  if (next === null) {
    return { _tag: "SignOut", previousAccountId: previous ?? null, isAccountTransition };
  }
  return {
    _tag: "SignIn",
    accountId: next,
    switchFromAccountId: previous ?? null,
    isAccountTransition,
  };
}

export interface CloudAccountHandlers<S extends CloudAccountSource> {
  /** Synchronously drops every credential so nothing reads the old account during cleanup. */
  readonly deactivate: () => void;
  readonly cleanUp: (input: {
    readonly source: S;
    readonly accountId: string | null;
    /** Whether `accountId` finished activating, so per-account registrations exist. */
    readonly wasActive: boolean;
  }) => Promise<void>;
  /** Async work that must finish before the session is visible (draft restore etc.). */
  readonly prepare?: (input: {
    readonly source: S;
    readonly accountId: string;
    readonly isCurrent: () => boolean;
  }) => Promise<void>;
  readonly activate: (input: {
    readonly source: S;
    readonly accountId: string;
    readonly isAccountTransition: boolean;
  }) => void;
  readonly onSignOutTransition?: () => void;
  /** Releases credentials when the service stops observing a Clerk instance. */
  readonly detach: () => void;
}

export type CloudAccountState =
  | { readonly _tag: "Unobserved" }
  | { readonly _tag: "SignedOut" }
  | { readonly _tag: "Activating"; readonly accountId: string }
  | { readonly _tag: "Active"; readonly accountId: string }
  /**
   * Activation rejected. The next emission for the same account retries the
   * original step, so a transient failure recovers on Clerk's next resource
   * change (token refreshes emit regularly) without re-requesting onboarding.
   */
  | {
      readonly _tag: "Failed";
      readonly accountId: string;
      readonly step: CloudAccountSignIn;
      readonly wasActive: boolean;
    };

export interface CloudAccountService<S extends CloudAccountSource> {
  /**
   * Observes `source` until the returned function runs. Attaching while another
   * source is attached detaches that one first.
   */
  readonly attach: (source: S) => () => void;
  readonly getState: () => CloudAccountState;
}

export function createCloudAccountService<S extends CloudAccountSource>(
  handlers: CloudAccountHandlers<S>,
): CloudAccountService<S> {
  let attached: { readonly source: S; readonly unsubscribe: () => void } | null = null;
  let state: CloudAccountState = { _tag: "Unobserved" };
  // Bumped on every account change so a superseded activation never applies.
  let generation = 0;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (label: string, operation: () => Promise<void>) => {
    const run = tail.then(operation, operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    void settlePromise(() => run).then((result) => reportAtomCommandResult(result, { label }));
  };

  const observedAccount = (): string | null | undefined => {
    switch (state._tag) {
      case "Unobserved":
        return undefined;
      case "SignedOut":
        return null;
      default:
        return state.accountId;
    }
  };

  const activate = (source: S, step: CloudAccountSignIn, wasActive: boolean) => {
    const activation = generation;
    const isCurrent = () => activation === generation;
    state = { _tag: "Activating", accountId: step.accountId };
    if (step.switchFromAccountId !== null) handlers.deactivate();
    enqueue("cloud account activation", async () => {
      try {
        if (step.switchFromAccountId !== null) {
          await handlers.cleanUp({ source, accountId: step.switchFromAccountId, wasActive });
        }
        if (!isCurrent()) return;
        await handlers.prepare?.({ source, accountId: step.accountId, isCurrent });
      } catch (error) {
        if (isCurrent()) state = { _tag: "Failed", accountId: step.accountId, step, wasActive };
        throw error;
      }
      if (!isCurrent()) return;
      state = { _tag: "Active", accountId: step.accountId };
      handlers.activate({
        source,
        accountId: step.accountId,
        isAccountTransition: step.isAccountTransition,
      });
    });
  };

  const observe = (source: S, next: string | null) => {
    const previousState = state;
    if (previousState._tag === "Failed" && previousState.accountId === next) {
      generation += 1;
      activate(source, previousState.step, previousState.wasActive);
      return;
    }
    const step = planCloudAccountStep(observedAccount(), next);
    if (step._tag === "None") return;
    generation += 1;
    const wasActive = previousState._tag === "Active";

    if (step._tag === "SignOut") {
      state = { _tag: "SignedOut" };
      if (step.isAccountTransition) handlers.onSignOutTransition?.();
      handlers.deactivate();
      enqueue("cloud account cleanup", () =>
        handlers.cleanUp({ source, accountId: step.previousAccountId, wasActive }),
      );
      return;
    }

    activate(source, step, wasActive);
  };

  const detach = () => {
    if (!attached) return;
    attached.unsubscribe();
    attached = null;
    generation += 1;
    state = { _tag: "Unobserved" };
    handlers.detach();
  };

  return {
    attach(source) {
      detach();
      const current = {
        source,
        unsubscribe: source.addListener((resources) => {
          // Clerk reports `user: undefined` until it loads; pending sessions
          // still carry a user and count as signed in.
          if (resources.user === undefined) return;
          observe(source, resources.user?.id ?? null);
        }),
      };
      attached = current;
      return () => {
        if (attached === current) detach();
      };
    },
    getState: () => state,
  };
}
