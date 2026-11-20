import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", async (importOriginal) => ({
  resolveAppScheme: (await importOriginal<typeof import("../../scripts/lib/public-config.ts")>())
    .resolveAppScheme,
  // app.config copies these into process.env, so an unset key must stay absent, not "undefined".
  loadRepoEnv: () =>
    Object.fromEntries(
      [
        "APP_VARIANT",
        "T3CODE_STANDALONE",
        "T3CODE_EAS_PROJECT_ID",
        "T3CODE_HOSTED_APP_URL",
        "T3CODE_MOBILE_BUNDLE_ID",
        "T3CODE_IOS_TEAM_ID",
        "T3CODE_DESKTOP_UPDATE_REPOSITORY",
        "T3CODE_APP_SCHEME",
        "T3CODE_APP_NAME",
      ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
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
  expect(config.scheme).toBe(identifier.replace("com.t3tools.t3code", "t3code").replace(".", "-"));
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

it("keeps T3's Expo project, owner, hosted app, and Apple team out of a standalone build", async () => {
  vi.stubEnv("T3CODE_STANDALONE", "1");
  vi.stubEnv("T3CODE_MOBILE_BUNDLE_ID", "com.fork.code");
  const config = await loadConfig("production");
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.updates).toMatchObject({ enabled: false });
  expect(config.updates?.url).toBeUndefined();
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas?.projectId).toBeUndefined();
  expect(config.extra?.hostedAppUrl).toBe("");
  expect(config.ios?.associatedDomains).toEqual([]);
  expect(config.android?.intentFilters).toEqual([]);
  expect(JSON.stringify(config)).not.toMatch(/t3\.codes|d763fcb8|pingdotgg|t3tools|ARK85ZXQ4Z/);
});

it("requires a standalone build to bring its own bundle identifier", async () => {
  vi.stubEnv("T3CODE_STANDALONE", "1");
  await expect(loadConfig("production")).rejects.toThrow("T3CODE_MOBILE_BUNDLE_ID");
  vi.stubEnv("T3CODE_MOBILE_BUNDLE_ID", "com.fork-code.app");
  await expect(loadConfig("production")).rejects.toThrow("T3CODE_MOBILE_BUNDLE_ID");
});

it.each([
  ["development", "com.fork.code.dev"],
  ["preview", "com.fork.code.preview"],
  ["production", "com.fork.code"],
])("signs APP_VARIANT=%j as the fork's app", async (value, identifier) => {
  vi.stubEnv("T3CODE_MOBILE_BUNDLE_ID", "com.fork.code");
  vi.stubEnv("T3CODE_IOS_TEAM_ID", "FORKTEAM01");
  vi.stubEnv("T3CODE_APP_SCHEME", "forkcode");
  vi.stubEnv("T3CODE_DESKTOP_UPDATE_REPOSITORY", "fork/t3code");
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.ios?.appleTeamId).toBe("FORKTEAM01");
  // The URL scheme follows the variant like the identifier: forkcode, forkcode-dev, forkcode-preview.
  expect(config.scheme).toBe(identifier.replace("com.fork.code", "forkcode").replace(".", "-"));
  expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
    `$(AppIdentifierPrefix)${identifier}`,
  ]);
  expect(config.extra?.releaseRepository).toBe("fork/t3code");
});

it("uses the fork's own Expo project and hosted app in a standalone build", async () => {
  vi.stubEnv("T3CODE_STANDALONE", "1");
  vi.stubEnv("T3CODE_MOBILE_BUNDLE_ID", "com.fork.code");
  vi.stubEnv("T3CODE_EAS_PROJECT_ID", "fork-project");
  vi.stubEnv("T3CODE_HOSTED_APP_URL", "https://app.fork.example");
  vi.stubEnv("T3CODE_APP_NAME", "Fork Code");
  const config = await loadConfig("production");
  expect(config.name).toBe("Fork Code");
  expect(JSON.stringify(config)).not.toMatch(/T3 Code/);
  expect(config.updates).toMatchObject({ enabled: true, url: "https://u.expo.dev/fork-project" });
  expect(config.extra?.eas?.projectId).toBe("fork-project");
  expect(config.ios?.associatedDomains).toEqual(["applinks:app.fork.example"]);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host: "app.fork.example", pathPrefix: "/threads/" },
  ]);
});
