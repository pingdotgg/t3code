import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { PiAgentDriver, resolvePiAgentSettingsPaths } from "./PiAgentDriver.ts";

describe("PiAgentDriver", () => {
  it("is an Early Access multi-instance driver with a disabled default", () => {
    expect(PiAgentDriver.driverKind).toBe("piAgent");
    expect(PiAgentDriver.metadata).toMatchObject({
      displayName: "Pi Agent",
      supportsMultipleInstances: true,
    });
    expect(PiAgentDriver.defaultConfig()).toMatchObject({
      enabled: false,
      binaryPath: "pi",
      agentDir: "",
      sessionDir: "",
      customModels: [],
    });
  });

  it("resolves relative profile directories from the stable server root", () => {
    expect(
      resolvePiAgentSettingsPaths(
        {
          enabled: true,
          binaryPath: "pi",
          agentDir: ".pi/profile",
          sessionDir: ".pi/sessions",
          customModels: [],
        },
        "/srv/t3code",
        (path, ...paths) => [path, ...paths].join("/"),
      ),
    ).toMatchObject({
      agentDir: "/srv/t3code/.pi/profile",
      sessionDir: "/srv/t3code/.pi/sessions",
    });
  });
});
