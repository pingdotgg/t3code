import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as NodeURL from "node:url";
import { AndroidConfig, IOSConfig } from "expo/config-plugins";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    T3CODE_MOBILE_UPDATES_ENABLED: process.env.T3CODE_MOBILE_UPDATES_ENABLED,
    T3CODE_MOBILE_EAS_PROJECT_ID: process.env.T3CODE_MOBILE_EAS_PROJECT_ID,
    T3CODE_MOBILE_EAS_OWNER: process.env.T3CODE_MOBILE_EAS_OWNER,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(
  variant: string | undefined,
  mobileEnv: Readonly<Record<string, string | undefined>> = {},
) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  for (const name of [
    "T3CODE_MOBILE_UPDATES_ENABLED",
    "T3CODE_MOBILE_EAS_PROJECT_ID",
    "T3CODE_MOBILE_EAS_OWNER",
  ]) {
    vi.stubEnv(name, mobileEnv[name]);
  }
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

it("keeps a fork's bundled client instead of accepting upstream OTA updates by default", async () => {
  const config = await loadConfig("production");
  const native = await nativeUpdatesConfig(config);
  expect(native.ios.EXUpdatesEnabled).toBe(false);
  expect(native.android["expo.modules.updates.ENABLED"]).toBe("false");
});

it.each([
  [undefined, false],
  ["0", false],
  ["1", true],
])(
  "uses one explicitly configured EAS project with updates enabled=%j",
  async (enabled, expected) => {
    const projectId = "6b739d79-41f7-4a38-8bf8-1d9e0e256f08";
    const config = await loadConfig("preview", {
      T3CODE_MOBILE_UPDATES_ENABLED: enabled,
      T3CODE_MOBILE_EAS_PROJECT_ID: projectId,
      T3CODE_MOBILE_EAS_OWNER: "fork-owner",
    });
    expect(config.updates?.enabled).toBe(expected);
    expect(config.updates?.url).toBe(`https://u.expo.dev/${projectId}`);
    expect(config.extra?.eas.projectId).toBe(projectId);
    expect(config.owner).toBe("fork-owner");
    const native = await nativeUpdatesConfig(config);
    expect(native.ios.EXUpdatesEnabled).toBe(expected);
    expect(native.ios.EXUpdatesURL).toBe(`https://u.expo.dev/${projectId}`);
    expect(native.android["expo.modules.updates.ENABLED"]).toBe(String(expected));
    expect(native.android["expo.modules.updates.EXPO_UPDATE_URL"]).toBe(
      `https://u.expo.dev/${projectId}`,
    );
  },
);

async function nativeUpdatesConfig(config: Awaited<ReturnType<typeof loadConfig>>) {
  const projectRoot = NodeURL.fileURLToPath(new URL(".", import.meta.url));
  const ios = await IOSConfig.Updates.setUpdatesConfigAsync(projectRoot, config, {
    EXUpdatesEnabled: true,
    EXUpdatesURL: "https://u.expo.dev/previous-project",
  });
  const manifest = await AndroidConfig.Updates.setUpdatesConfigAsync(projectRoot, config, {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      queries: [],
      application: [
        {
          $: { "android:name": ".MainApplication" },
          "meta-data": [
            { $: { "android:name": "expo.modules.updates.ENABLED", "android:value": "true" } },
            {
              $: {
                "android:name": "expo.modules.updates.EXPO_UPDATE_URL",
                "android:value": "https://u.expo.dev/previous-project",
              },
            },
          ],
        },
      ],
    },
  });
  const android = Object.fromEntries(
    AndroidConfig.Manifest.getMainApplicationOrThrow(manifest)["meta-data"]!.map((item) => [
      item.$["android:name"],
      item.$["android:value"],
    ]),
  );
  return { ios, android };
}
