import type { useClerk } from "@clerk/react";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";

type ClerkStatus = ReturnType<typeof useClerk>["status"];

export interface ClerkStatusSource {
  readonly on: (
    event: "status",
    handler: (status: ClerkStatus) => void,
    options?: { readonly notify: boolean },
  ) => void;
  readonly off: (event: "status", handler: (status: ClerkStatus) => void) => void;
}

export interface ClerkLoadRecoveryEnvironment {
  /** Whether Clerk's servers answer now. */
  readonly probe: () => Promise<boolean>;
  readonly reload: () => void;
  readonly storage: () => Storage;
  /** A reload now would throw away input the user has not saved. */
  readonly isEditing: () => boolean;
  readonly setFailed: (failed: boolean) => void;
  /** Runs `check` whenever Clerk may have become reachable, until the returned stop runs. */
  readonly watchReachability: (check: () => Promise<void>) => () => void;
}

// Clerk keeps a failed script load for the life of the page, so only a reload recovers it.
// One automatic reload per failure streak; a successful load clears the guard.
const RELOAD_GUARD_KEY = "t3code:clerk-load-reloaded";

function claimAutomaticReload(storage: () => Storage): boolean {
  try {
    const store = storage();
    if (store.getItem(RELOAD_GUARD_KEY) === "1") return false;
    store.setItem(RELOAD_GUARD_KEY, "1");
    return true;
  } catch {
    // Without storage, the guard cannot prevent a reload loop.
    return false;
  }
}

function clearAutomaticReloadGuard(storage: () => Storage): void {
  try {
    storage().removeItem(RELOAD_GUARD_KEY);
  } catch {}
}

/**
 * Marks T3 Connect sign-in as failed while Clerk's status is "error", and reloads
 * the page once Clerk answers again. Returns a function that stops watching.
 */
export function watchClerkLoadRecovery(
  source: ClerkStatusSource,
  environment: ClerkLoadRecoveryEnvironment,
): () => void {
  let stopWatching: (() => void) | null = null;
  let failed = false;
  let checking = false;

  const check = async () => {
    if (!failed || checking || environment.isEditing()) return;
    checking = true;
    try {
      if (!(await environment.probe())) return;
      if (!failed || environment.isEditing()) return;
      if (claimAutomaticReload(environment.storage)) environment.reload();
    } finally {
      checking = false;
    }
  };

  const stop = () => {
    failed = false;
    stopWatching?.();
    stopWatching = null;
  };

  const onStatus = (status: ClerkStatus) => {
    environment.setFailed(status === "error");
    if (status === "error") {
      if (failed) return;
      failed = true;
      stopWatching = environment.watchReachability(check);
      return;
    }
    stop();
    if (status === "ready" || status === "degraded") {
      clearAutomaticReloadGuard(environment.storage);
    }
  };

  source.on("status", onStatus, { notify: true });
  return () => {
    source.off("status", onStatus);
    stop();
    environment.setFailed(false);
  };
}

const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function holdsText(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return element.value !== "";
  if (element instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(element.type) && element.value !== "";
  }
  return (
    element instanceof HTMLElement &&
    element.isContentEditable &&
    (element.textContent ?? "").trim() !== ""
  );
}

/** Whether a reload now would throw away input the user has not saved. */
export function hasUnsavedInput(): boolean {
  if (holdsText(document.activeElement)) return true;
  // Dialogs keep their drafts in React state, beyond the fields mounted now. Closed dialogs can
  // stay mounted, hidden, so only visible ones count.
  for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
    if (dialog.checkVisibility()) return true;
  }
  return false;
}

export function browserClerkLoadRecoveryEnvironment(input: {
  readonly publishableKey: string;
  readonly setFailed: (failed: boolean) => void;
}): ClerkLoadRecoveryEnvironment {
  const probeUrl = `${clerkFrontendApiUrlFromPublishableKey(input.publishableKey)}/v1/environment`;
  return {
    probe: async () => {
      if (!navigator.onLine) return false;
      try {
        // Any answer proves the path to Clerk works; no-cors skips reading the body.
        await fetch(probeUrl, {
          mode: "no-cors",
          cache: "no-store",
          credentials: "omit",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return true;
      } catch {
        return false;
      }
    },
    reload: () => window.location.reload(),
    storage: () => window.sessionStorage,
    isEditing: hasUnsavedInput,
    setFailed: input.setFailed,
    watchReachability: (check) => {
      const run = () => void check();
      const runWhenVisible = () => {
        if (document.visibilityState === "visible") run();
      };
      window.addEventListener("online", run);
      window.addEventListener("focus", run);
      document.addEventListener("visibilitychange", runWhenVisible);
      // Some network recoveries fire no event, such as a DNS or VPN change.
      const interval = window.setInterval(run, PROBE_INTERVAL_MS);
      // The network can come back before Clerk reports the failure.
      run();
      return () => {
        window.removeEventListener("online", run);
        window.removeEventListener("focus", run);
        document.removeEventListener("visibilitychange", runWhenVisible);
        window.clearInterval(interval);
      };
    },
  };
}
