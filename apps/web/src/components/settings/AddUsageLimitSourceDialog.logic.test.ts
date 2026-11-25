import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@lathe/contracts";
import { applyServerSettingsPatch } from "@lathe/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { sourceIdFromUrl } from "./AddUsageLimitSourceDialog.logic";

describe("adding usage limit sources", () => {
  it.each([
    ["http://proxy.test:8318/hub-a", "http://proxy.test:8318/hub-b"],
    ["localhost:8318", "localhost:9318"],
  ])("retains saved configurations for %s and %s", (firstUrl, secondUrl) => {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    const sources = [
      [firstUrl, "First hub", "first-key"],
      [secondUrl, "Second hub", "second-key"],
      [`${secondUrl}/extra`, "Third hub", "third-key"],
    ] as const;
    for (const [url, label, managementKey] of sources) {
      const id = sourceIdFromUrl(url, settings.usageLimitSources);
      settings = applyServerSettingsPatch(settings, {
        usageLimitSources: {
          [id]: { kind: "cliproxy", url, label, managementKey, enabled: true },
        },
      });
    }
    expect(Object.values(settings.usageLimitSources)).toEqual(
      sources.map(([url, label, managementKey]) => ({
        kind: "cliproxy",
        url,
        label,
        managementKey,
        enabled: true,
      })),
    );
  });

  it("gives a gateway its own entry beside a hub at the same URL", () => {
    const url = "https://proxy.test";
    const hub = sourceIdFromUrl(url, DEFAULT_SERVER_SETTINGS.usageLimitSources, "cliproxy");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usageLimitSources: { [hub]: { kind: "cliproxy", url, managementKey: "key", enabled: true } },
    });
    const gateway = sourceIdFromUrl(url, settings.usageLimitSources, "modelproxy");
    expect([hub, gateway]).toEqual(["cliproxy-proxy.test", "modelproxy-proxy.test"]);
    const saved = applyServerSettingsPatch(settings, {
      usageLimitSources: {
        [gateway]: {
          kind: "modelproxy",
          url,
          issuer: "https://auth.test/realms/main",
          clientId: "lathe",
          clientSecret: "",
          enabled: true,
        },
      },
    });
    // Adding the gateway again updates it, not the hub.
    expect(sourceIdFromUrl(url, saved.usageLimitSources, "modelproxy")).toBe(gateway);
  });

  it("updates a saved hub when its URL is added again", () => {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    for (const managementKey of ["old-key", "new-key"]) {
      const url = "http://proxy.test:8318/hub-a";
      settings = applyServerSettingsPatch(settings, {
        usageLimitSources: {
          [sourceIdFromUrl(url, settings.usageLimitSources)]: {
            kind: "cliproxy",
            url,
            managementKey,
            enabled: true,
          },
        },
      });
    }
    expect(Object.values(settings.usageLimitSources)).toEqual([
      {
        kind: "cliproxy",
        url: "http://proxy.test:8318/hub-a",
        managementKey: "new-key",
        enabled: true,
      },
    ]);
  });
});
