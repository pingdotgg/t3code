import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  // The config copies these into process.env, where an undefined value would become "undefined".
  loadRepoEnv: () =>
    Object.fromEntries(
      [
        "APP_VARIANT",
        "T3CODE_IOS_TEAM_ID",
        "T3CODE_IOS_BUNDLE_ID",
        "T3CODE_IOS_PERSONAL_TEAM",
        "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
        "T3CODE_MOBILE_UPDATES_ENABLED",
      ].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined, env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("signs an own-team build with its team and bundle id, keeping push but not updates", async () => {
  const config = await loadConfig("production", {
    T3CODE_IOS_TEAM_ID: "ABCDE12345",
    T3CODE_IOS_BUNDLE_ID: "com.example.t3code",
  });
  expect(config.ios?.appleTeamId).toBe("ABCDE12345");
  expect(config.ios?.bundleIdentifier).toBe("com.example.t3code");
  expect(config.updates?.enabled).toBe(false);
  const pluginNames = config.plugins?.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  expect(pluginNames).toContain("expo-widgets");
  expect(pluginNames).not.toContain("./plugins/withoutIosPersonalTeamCapabilities.cjs");

  const withUpdates = await loadConfig("production", {
    T3CODE_IOS_TEAM_ID: "ABCDE12345",
    T3CODE_IOS_BUNDLE_ID: "com.example.t3code",
    T3CODE_MOBILE_UPDATES_ENABLED: "1",
  });
  expect(withUpdates.updates?.enabled).toBe(true);
});

it("signs a Personal Team build with your team, or leaves the team to the local identity", async () => {
  const personal = {
    T3CODE_IOS_PERSONAL_TEAM: "1",
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.t3code",
  };
  // First: the config copies its env into process.env, so a team set earlier would linger.
  expect((await loadConfig("production", personal)).ios?.appleTeamId).toBeUndefined();
  const withTeam = await loadConfig("production", {
    ...personal,
    T3CODE_IOS_TEAM_ID: "ABCDE12345",
  });
  expect(withTeam.ios?.appleTeamId).toBe("ABCDE12345");
  expect(withTeam.ios?.bundleIdentifier).toBe("com.example.t3code");
});

it.each([
  [{ T3CODE_IOS_BUNDLE_ID: "com.example.t3code" }, "T3CODE_IOS_TEAM_ID must be set"],
  [{ T3CODE_IOS_TEAM_ID: "ABCDE12345" }, "T3CODE_IOS_BUNDLE_ID"],
  [{ T3CODE_IOS_TEAM_ID: "abc" }, "10-character"],
  [
    {
      T3CODE_IOS_BUNDLE_ID: "com.example.t3code",
      T3CODE_IOS_PERSONAL_TEAM: "1",
      T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.t3code",
    },
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID, not T3CODE_IOS_BUNDLE_ID",
  ],
])("rejects an inconsistent own-team build %j", async (env, message) => {
  await expect(loadConfig("production", env)).rejects.toThrow(message);
});
