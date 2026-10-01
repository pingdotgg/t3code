/**
 * `t3.browser/profiles` consumer logic — the package counterpart of the
 * native profile heading, "Clear cookies" / "Clear cache" (`PreviewMoreMenu`)
 * and the settings import menu. Each action rides its own grant, so a
 * missing one disables only that action and says which grant by name.
 * Nothing is applied optimistically: every message reports what the desktop
 * answered.
 */
import { describeGrantDenial } from "@t3tools/extension-sdk/capabilities";
import {
  BROWSER_CLEAR_CACHE,
  BROWSER_CLEAR_COOKIES,
  BROWSER_IMPORT_COOKIES,
  BROWSER_PROFILES,
  type BrowserImportCookiesResult,
  type BrowserImportFailureReason,
  type BrowserImportSourceSummary,
  type BrowserProfileChange,
  type BrowserProfileClearResult,
  type BrowserProfileList,
  type BrowserSession,
} from "@t3tools/extension-sdk/catalogue";

/** The built-in profile a session without an explicit one renders under. */
export const DEFAULT_PROFILE_ID = "default";

export type ProfileAction =
  | "list"
  | "open"
  | "clearCookies"
  | "clearCache"
  | "listImportSources"
  | "importCookies";

/** The grant each action needs beyond the ones every browser session already holds. */
export const PROFILE_ACTION_GRANT: Readonly<Record<ProfileAction, string>> = {
  list: BROWSER_PROFILES,
  open: BROWSER_PROFILES,
  clearCookies: BROWSER_CLEAR_COOKIES,
  clearCache: BROWSER_CLEAR_CACHE,
  listImportSources: BROWSER_IMPORT_COOKIES,
  importCookies: BROWSER_IMPORT_COOKIES,
};

const ACTION_LABEL: Readonly<Record<ProfileAction, string>> = {
  list: "Listing browser profiles",
  open: "Opening the page in another profile",
  clearCookies: "Clearing cookies",
  clearCache: "Clearing the cache",
  listImportSources: "Listing browsers to import from",
  importCookies: "Importing cookies",
};

/** The profile a session renders under; an unset id is the default partition. */
export function sessionProfileId(session: BrowserSession | null): string {
  return session?.profileId ?? DEFAULT_PROFILE_ID;
}

/** Native parity: a session whose profile was deleted reads "Removed profile". */
export function profileLabel(list: BrowserProfileList | null, profileId: string): string {
  if (list === null) return profileId === DEFAULT_PROFILE_ID ? "Default" : profileId;
  return list.profiles.find((profile) => profile.id === profileId)?.name ?? "Removed profile";
}

/**
 * Native's chrome-row profile badge: the tab's profile name, shown only when
 * it differs from the default new tabs open under — labelling every tab
 * "Default" would be noise. Null until the list is known.
 */
export function profileBadgeName(
  list: BrowserProfileList | null,
  profileId: string,
): string | null {
  if (list === null || profileId === list.defaultProfileId) return null;
  return profileLabel(list, profileId);
}

/** A thrown call → one named line; a missing grant names the permission to grant. */
export function profileFailureMessage(action: ProfileAction, error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const label = ACTION_LABEL[action];
  const denial = describeGrantDenial(error);
  if (denial) return `${label} — ${denial.message}`;
  if (text.includes("(desktop-required)")) {
    return `${label} needs the T3 Code desktop app — no desktop browser engine is connected (desktop-required).`;
  }
  if (text.includes("(engine-unsupported)")) {
    return `${label} is not supported by this desktop's browser engine (engine-unsupported).`;
  }
  if (text.includes("BrowserProfileNotFound")) {
    return `${label} failed — that browser profile no longer exists (profile-not-found).`;
  }
  if (text.includes("BrowserProfilesUnavailable")) {
    return `${label} failed — the desktop did not answer in time (unknown).`;
  }
  return `${label} failed${text ? ` — ${text.slice(0, 300)}` : ""}.`;
}

/** Whether a failure line is a missing grant, which only a grant change can fix. */
export function isGrantDenial(error: unknown): boolean {
  return describeGrantDenial(error) !== null;
}

export function clearResultMessage(
  result: BrowserProfileClearResult,
  kind: "clearCookies" | "clearCache",
  profileName: string,
): string {
  const what = kind === "clearCookies" ? "cookies" : "the cache";
  if (result.outcome === "unknown") {
    return `The desktop did not confirm clearing ${what} for "${profileName}" (unknown) — it may or may not have happened.`;
  }
  return kind === "clearCookies"
    ? `Cookies cleared for "${profileName}" — every page in that profile is signed out.`
    : `Cache cleared for "${profileName}".`;
}

const IMPORT_FAILURE_COPY: Readonly<Record<BrowserImportFailureReason, string>> = {
  notInstalled: "that browser is not installed on the desktop",
  needsKeychainApproval: "the desktop needs Keychain access to read its cookies",
  keychainItemMissing: "no encryption key in the desktop's Keychain — sign in to that browser once",
  needsFullDiskAccess: "give T3 Code Full Disk Access on the desktop, then retry",
  browserRunning: "quit that browser on the desktop first",
  unsupportedPlatform: "importing from that browser isn't possible on the desktop's platform",
  keychainUnavailable: "the desktop's system keyring could not be accessed",
  unknownSource: "that browser is no longer available to import from",
  unknownSourceProfile: "that browser profile no longer exists",
  sessionUnavailable: "the target profile could not be opened",
  readFailed: "the browser's cookie database could not be read",
};

export function importResultMessage(
  result: BrowserImportCookiesResult,
  profileName: string,
): string {
  switch (result.outcome) {
    case "imported":
      return `Imported ${result.imported} cookie${result.imported === 1 ? "" : "s"} into "${profileName}"${
        result.skipped > 0 ? ` (${result.skipped} skipped)` : ""
      }.`;
    case "declined":
      return "Cookie import was declined on the desktop.";
    case "unknown":
      return "The desktop did not answer the import (unknown) — check the T3 Code desktop app.";
    case "failed":
      return `Cookie import failed (${result.reason}) — ${IMPORT_FAILURE_COPY[result.reason]}.`;
  }
}

/**
 * Native parity with the settings import menu: a browser that is missing or
 * can never be read on this platform is left out; every other unavailable
 * reason stays, since each names a step the user can take.
 */
export function importableSources(
  sources: readonly BrowserImportSourceSummary[],
): readonly BrowserImportSourceSummary[] {
  return sources.filter(
    (source) =>
      source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform",
  );
}

/**
 * How to reopen a page whose session is gone (lease ended, recovery gave
 * up): in the same profile the dead session had, never silently in the
 * default one. A non-default profile needs `t3.browser/profiles.open`.
 */
export function reopenRequest(
  previous: BrowserSession | null,
  url: string,
):
  | { readonly api: "sessions"; readonly input: { readonly url: string } }
  | {
      readonly api: "profiles";
      readonly input: { readonly profileId: string; readonly url: string };
    } {
  const profileId = sessionProfileId(previous);
  return profileId === DEFAULT_PROFILE_ID
    ? { api: "sessions", input: { url } }
    : { api: "profiles", input: { profileId, url } };
}

/** Same ids, names, order and default: a re-sent list that changes nothing. */
export function sameProfileList(a: BrowserProfileList | null, b: BrowserProfileList | null) {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.defaultProfileId === b.defaultProfileId &&
      a.profiles.length === b.profiles.length &&
      a.profiles.every(
        (profile, index) =>
          profile.id === b.profiles[index]!.id && profile.name === b.profiles[index]!.name,
      ))
  );
}

export type ProfileListSnapshot = {
  readonly list: BrowserProfileList | null;
  /**
   * Why no list is known: the last read's or the stream's failure, or no
   * desktop connected to own profiles.
   */
  readonly error: unknown;
};

/** The stream's "no desktop" state, worded as the list read's refusal is. */
const DESKTOP_REQUIRED = new Error(
  "no desktop browser engine is connected to this environment (desktop-required).",
);

export interface ProfileListSource {
  readonly invoke: (
    method: "list",
    input: Record<string, never>,
    signal: AbortSignal,
  ) => Promise<BrowserProfileList>;
  /**
   * The host's `changes` stream, or null when the host predates it
   * (`t3.browser/profiles` below 1.1.0).
   */
  readonly watch: (signal: AbortSignal) => Promise<AsyncIterable<BrowserProfileChange> | null>;
}

export interface ProfileListStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ProfileListSnapshot;
  /**
   * The list may have changed: on a host with the stream this only (re)starts
   * it, since the stream already delivers every change; on an older host it
   * reads the list again.
   */
  readonly refresh: () => void;
}

/**
 * One view's profile list, shared by the badge and the page menu. A host
 * serving the `changes` stream pushes each change, so the view never asks;
 * an older host is read when the view calls `refresh` (on show, per held
 * profile, per menu open). An unchanged list keeps its snapshot, so nothing
 * re-renders for it. With no desktop connected, or a stream that failed,
 * there is no list and `error` says why; with neither a list nor an error
 * the list is loading. An old list is never kept as if it were current.
 */
export function createProfileListStore(
  source: ProfileListSource,
  signal: AbortSignal,
): ProfileListStore {
  let snapshot: ProfileListSnapshot = { list: null, error: null };
  /** idle → probing → live, or reads on an older host; a stream that ends goes back to idle. */
  let mode: "idle" | "probing" | "live" | "reads" = "idle";
  let read = 0;
  const listeners = new Set<() => void>();
  const set = (next: ProfileListSnapshot) => {
    if (sameProfileList(snapshot.list, next.list) && snapshot.error === next.error) return;
    snapshot = sameProfileList(snapshot.list, next.list) ? { ...next, list: snapshot.list } : next;
    for (const listener of listeners) listener();
  };
  const readList = () => {
    // Only the newest read may land; an older answer is an older list.
    const current = ++read;
    void source.invoke("list", {}, signal).then(
      (list) => {
        if (current === read && mode === "reads") set({ list, error: null });
      },
      (error: unknown) => {
        if (current === read && mode === "reads") set({ list: null, error });
      },
    );
  };
  const watch = async () => {
    mode = "probing";
    const changes = await source.watch(signal).catch(() => null);
    if (signal.aborted) return;
    if (changes === null) {
      mode = "reads";
      readList();
      return;
    }
    mode = "live";
    try {
      for await (const change of changes) {
        // A desktop that has not reported its list yet is loading, not absent.
        set(
          change.list !== null
            ? { list: change.list, error: null }
            : { list: null, error: change.pending ? null : DESKTOP_REQUIRED },
        );
      }
    } catch (error) {
      // Resubscribed on the next refresh; until then the menu names the failure.
      if (!signal.aborted) set({ list: null, error });
    }
    if (!signal.aborted) mode = "idle";
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh() {
      if (signal.aborted) return;
      if (mode === "idle") void watch();
      else if (mode === "reads") readList();
    },
  };
}
