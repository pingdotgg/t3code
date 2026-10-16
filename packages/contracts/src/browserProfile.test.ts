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
    const resolved = resolveBrowserProfiles([
      { id: "work", name: "Work", kind: "persistent" },
      { id: "work", name: "Work (old)", kind: "persistent" },
    ]);

    expect(resolved.filter((profile) => profile.id === "work")).toEqual([
      { id: "work", name: "Work", kind: "persistent" },
    ]);
  });

  it("reports a custom incognito profile as persistent", () => {
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
    expect(Schema.is(BrowserProfileId)("profile-a\u0000b")).toBe(false);
    expect(Schema.is(BrowserProfileId)("profile-a")).toBe(true);
  });
});
