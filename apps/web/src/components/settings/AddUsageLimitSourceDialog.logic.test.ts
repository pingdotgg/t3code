import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
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
