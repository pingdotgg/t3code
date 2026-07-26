import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { loadPreferences, savePreferencesPatch } from "../lib/storage";
import { appAtomRegistry } from "./atom-registry";

/**
 * Composer-level "create PR when done" toggle. Global rather than per-thread,
 * matching the macOS composer's `AutoPRToggle`: the choice survives thread
 * switches and relaunches. When on, the first user message of a fresh thread
 * carries `CREATE_PULL_REQUEST_MESSAGE_SUFFIX`.
 */
export const autoCreatePullRequestAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer:auto-create-pull-request"),
);

let hydrationStarted = false;

/**
 * Reads the persisted value once per app run. Kept out of the atom itself so
 * the composer never blocks on storage — it renders "off" until the stored
 * value arrives, which is also the correct default.
 */
export function ensureAutoCreatePullRequestLoaded(): void {
  if (hydrationStarted) {
    return;
  }
  hydrationStarted = true;

  void loadPreferences()
    .then((preferences) => {
      if (typeof preferences.autoCreatePullRequest === "boolean") {
        appAtomRegistry.set(autoCreatePullRequestAtom, preferences.autoCreatePullRequest);
      }
    })
    .catch((cause: unknown) => {
      console.warn("[composer] could not load the auto-PR preference", cause);
    });
}

export function getAutoCreatePullRequest(): boolean {
  return appAtomRegistry.get(autoCreatePullRequestAtom);
}

export function setAutoCreatePullRequest(value: boolean): void {
  appAtomRegistry.set(autoCreatePullRequestAtom, value);
  void savePreferencesPatch({ autoCreatePullRequest: value }).catch((cause: unknown) => {
    console.warn("[composer] could not persist the auto-PR preference", cause);
  });
}

export function useAutoCreatePullRequest(): boolean {
  useEffect(() => {
    ensureAutoCreatePullRequestLoaded();
  }, []);
  return useAtomValue(autoCreatePullRequestAtom);
}
