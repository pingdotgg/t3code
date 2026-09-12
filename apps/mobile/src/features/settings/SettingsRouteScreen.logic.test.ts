import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_SESSION_IMPORT_WINDOW_LABELS,
  parseAgentSessionImportWindow,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("explains that agent awareness settings are unavailable on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: false,
      subtitle: "iOS only",
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});

describe("parseAgentSessionImportWindow", () => {
  it("accepts every import window literal", () => {
    expect(parseAgentSessionImportWindow("30d")).toBe("30d");
    expect(parseAgentSessionImportWindow("90d")).toBe("90d");
    expect(parseAgentSessionImportWindow("1y")).toBe("1y");
    expect(parseAgentSessionImportWindow("all")).toBe("all");
  });

  it("rejects values that are not import windows", () => {
    expect(parseAgentSessionImportWindow("")).toBe(null);
    expect(parseAgentSessionImportWindow("forever")).toBe(null);
  });
});

describe("AGENT_SESSION_IMPORT_WINDOW_LABELS", () => {
  it("labels every import window", () => {
    expect(Object.keys(AGENT_SESSION_IMPORT_WINDOW_LABELS).sort()).toEqual(
      ["30d", "90d", "1y", "all"].sort(),
    );
  });
});
