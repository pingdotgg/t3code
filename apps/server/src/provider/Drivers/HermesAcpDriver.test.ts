import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { HermesAcpDriver } from "./HermesAcpDriver.ts";

describe("HermesAcpDriver", () => {
  it("is a first-class instance-only driver separate from Hermes Work", () => {
    expect(BUILT_IN_DRIVERS).toContain(HermesAcpDriver);
    expect(HermesAcpDriver.driverKind).toBe("hermesAcp");
    expect(HermesAcpDriver.metadata.displayName).toBe("Hermes in Code");
    expect(HermesAcpDriver.defaultConfig()).toEqual({
      enabled: true,
      binaryPath: "hermes",
      customModels: [],
    });
  });
});
