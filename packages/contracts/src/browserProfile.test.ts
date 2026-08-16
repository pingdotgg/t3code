import { describe, expect, it } from "@effect/vitest";

import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  findBrowserProfile,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  type BrowserProfile,
} from "./browserProfile.ts";

const work: BrowserProfile = { id: "profile-work", name: "Work", kind: "persistent" };

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
