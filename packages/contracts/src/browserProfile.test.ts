import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import {
  BrowserProfileId,
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  findBrowserProfile,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  browserProfileUserAgent,
  BrowserProfile,
} from "./browserProfile.ts";

const work: BrowserProfile = { id: "profile-work", name: "Work", kind: "persistent" };
const isBrowserProfile = Schema.is(BrowserProfile);

describe("resolveBrowserProfiles", () => {
  it("lists built-ins ahead of the user's own profiles", () => {
    const resolved = resolveBrowserProfiles([work]);

    expect(resolved.map((profile) => profile.id)).toEqual([
      DEFAULT_BROWSER_PROFILE_ID,
      INCOGNITO_BROWSER_PROFILE_ID,
      work.id,
    ]);
  });

  it("drops stored entries that collide with a built-in id", () => {
    // Built-ins are synthesized rather than stored, so a hand-edited settings
    // file must not be able to shadow Default with a persistent partition of
    // its own — every tab already opened under Default would follow it.
    const resolved = resolveBrowserProfiles([
      { id: DEFAULT_BROWSER_PROFILE_ID, name: "Hijacked", kind: "persistent" },
      { id: INCOGNITO_BROWSER_PROFILE_ID, name: "Not incognito", kind: "persistent" },
      work,
    ]);

    expect(resolved).toEqual([...BUILT_IN_BROWSER_PROFILES, work]);
  });

  it("keeps incognito ephemeral", () => {
    const incognito = findBrowserProfile(resolveBrowserProfiles([]), INCOGNITO_BROWSER_PROFILE_ID);

    expect(incognito?.kind).toBe("incognito");
  });
});

describe("findBrowserProfile", () => {
  it("returns nothing for an id that no longer exists", () => {
    // The settings UI relies on this to fall back rather than opening tabs
    // into a partition with no profile behind it.
    expect(findBrowserProfile(resolveBrowserProfiles([]), work.id)).toBeUndefined();
    expect(findBrowserProfile(resolveBrowserProfiles([work]), undefined)).toBeUndefined();
  });
});

describe("isBuiltInBrowserProfileId", () => {
  it("separates built-ins from user profiles", () => {
    expect(isBuiltInBrowserProfileId(DEFAULT_BROWSER_PROFILE_ID)).toBe(true);
    expect(isBuiltInBrowserProfileId(INCOGNITO_BROWSER_PROFILE_ID)).toBe(true);
    expect(isBuiltInBrowserProfileId(work.id)).toBe(false);
  });
});

describe("resolveBrowserProfiles normalization", () => {
  it("keeps only the first entry for a repeated id", () => {
    // Both map to the same Electron partition, so presenting two would offer
    // isolated identities that in fact share every cookie.
    const resolved = resolveBrowserProfiles([
      { id: "work", name: "Work", kind: "persistent" },
      { id: "work", name: "Work (old)", kind: "persistent" },
    ]);

    expect(resolved.filter((profile) => profile.id === "work")).toEqual([
      { id: "work", name: "Work", kind: "persistent" },
    ]);
  });

  it("reports a custom incognito profile as persistent", () => {
    // Partition persistence is keyed off the built-in incognito id alone, so
    // a custom profile claiming that kind keeps its cookies across restarts.
    // Labelling it ephemeral would be a promise the partition layer breaks.
    const resolved = resolveBrowserProfiles([
      { id: "throwaway", name: "Throwaway", kind: "incognito" },
    ]);

    expect(resolved.find((profile) => profile.id === "throwaway")).toEqual({
      id: "throwaway",
      name: "Throwaway",
      kind: "persistent",
    });
  });

  it("still lets the built-in incognito profile stay ephemeral", () => {
    const incognito = resolveBrowserProfiles([]).find(
      (profile) => profile.id === INCOGNITO_BROWSER_PROFILE_ID,
    );

    expect(incognito?.kind).toBe("incognito");
  });
});

describe("BrowserProfileId", () => {
  it("rejects control characters", () => {
    // Ids are folded into delimiter-joined cache keys on the client, so one
    // carrying the delimiter would resolve to another profile's partition.
    expect(Schema.is(BrowserProfileId)("profile-a\u0000b")).toBe(false);
    expect(Schema.is(BrowserProfileId)("profile-a")).toBe(true);
  });
});

describe("browser profile User-Agent", () => {
  const native =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Nightly)/0.0.46 Chrome/152.0.7977.130 Electron/44.4.2 Safari/537.36";
  const chrome =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36";

  it("leaves existing profiles and built-in identities untouched", () => {
    expect(browserProfileUserAgent(native, undefined)).toBeUndefined();
    const profiles = resolveBrowserProfiles([
      { id: "default", name: "Override", kind: "persistent", userAgentMode: "chrome" },
      { id: "teams", name: "Teams", kind: "persistent", userAgentMode: "chrome" },
    ]);
    expect(profiles[0]?.userAgentMode).toBeUndefined();
    expect(profiles.find((profile) => profile.id === "teams")?.userAgentMode).toBe("chrome");
  });

  it("uses the running Chromium version and restores the exact native identity", () => {
    expect(browserProfileUserAgent(native, "chrome")).toBe(chrome);
    expect(browserProfileUserAgent(native, "native")).toBe(native);
  });

  it.each([
    "X11; Linux x86_64",
    "Windows NT 10.0; Win64; x64",
    "Macintosh; Intel Mac OS X 10_15_7",
  ])("preserves the platform and engine tokens on %s", (platform) => {
    const agent = native.replace("Macintosh; Intel Mac OS X 10_15_7", platform);
    expect(browserProfileUserAgent(agent, "chrome")).toBe(
      chrome.replace("Macintosh; Intel Mac OS X 10_15_7", platform),
    );
  });

  it("accepts only the supported modes while retaining old saved profiles", () => {
    const profile = { id: "teams", name: "Teams", kind: "persistent" };
    expect(isBrowserProfile(profile)).toBe(true);
    expect(isBrowserProfile({ ...profile, userAgentMode: "chrome" })).toBe(true);
    expect(isBrowserProfile({ ...profile, userAgentMode: "native" })).toBe(true);
    expect(isBrowserProfile({ ...profile, userAgentMode: "firefox" })).toBe(false);
  });
});
