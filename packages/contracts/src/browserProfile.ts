/**
 * Browser profiles - named identities for the in-app preview browser.
 *
 * Each profile maps to its own Electron session partition, so cookies and
 * storage are isolated between them: a tab opened under "Work" cannot see
 * "Personal"'s logins. Profiles are client-local, like the other browser
 * defaults, because the Chromium guest they configure is desktop-local.
 *
 * Two profiles are built in and cannot be edited or removed:
 * - `default` keeps the partition scope the browser used before profiles
 *   existed, so upgrading does not sign anyone out.
 * - `incognito` maps to a non-persistent partition for throwaway sessions.
 *
 * @module BrowserProfile
 */
import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BROWSER_PROFILE_NAME_MAX_LENGTH = 48;
export const BROWSER_PROFILE_MAX_COUNT = 24;

export const BrowserProfileId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type BrowserProfileId = typeof BrowserProfileId.Type;

export const BrowserProfileName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BROWSER_PROFILE_NAME_MAX_LENGTH),
);

/**
 * `persistent` profiles keep cookies on disk across restarts; `incognito`
 * uses an in-memory partition that Chromium discards with the process.
 */
export const BrowserProfileKind = Schema.Literals(["persistent", "incognito"]);
export type BrowserProfileKind = typeof BrowserProfileKind.Type;

export const BrowserProfile = Schema.Struct({
  id: BrowserProfileId,
  name: BrowserProfileName,
  kind: BrowserProfileKind,
});
export type BrowserProfile = typeof BrowserProfile.Type;

export const DEFAULT_BROWSER_PROFILE_ID: BrowserProfileId = "default";
export const INCOGNITO_BROWSER_PROFILE_ID: BrowserProfileId = "incognito";

/**
 * Built-ins are synthesized rather than stored, so they cannot be renamed out
 * of existence or deleted by editing the settings file by hand.
 */
export const BUILT_IN_BROWSER_PROFILES: ReadonlyArray<BrowserProfile> = [
  { id: DEFAULT_BROWSER_PROFILE_ID, name: "Default", kind: "persistent" },
  { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Incognito", kind: "incognito" },
];

export function isBuiltInBrowserProfileId(id: string): boolean {
  return BUILT_IN_BROWSER_PROFILES.some((profile) => profile.id === id);
}

/**
 * The full picker list: built-ins first, then the user's own profiles with any
 * entry that collides with a built-in id dropped, so a hand-edited settings
 * file cannot shadow "Default" or "Incognito".
 */
export function resolveBrowserProfiles(
  userProfiles: ReadonlyArray<BrowserProfile>,
): ReadonlyArray<BrowserProfile> {
  return [
    ...BUILT_IN_BROWSER_PROFILES,
    ...userProfiles.filter((profile) => !isBuiltInBrowserProfileId(profile.id)),
  ];
}

export function findBrowserProfile(
  profiles: ReadonlyArray<BrowserProfile>,
  id: string | undefined,
): BrowserProfile | undefined {
  return id === undefined ? undefined : profiles.find((profile) => profile.id === id);
}
