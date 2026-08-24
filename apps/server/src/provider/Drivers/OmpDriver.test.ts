import { OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { OmpDriver } from "./OmpDriver.ts";

describe("OmpDriver", () => {
  it("registers Oh My Pi as a separate first-party provider", () => {
    expect(OmpDriver.driverKind).toBe(ProviderDriverKind.make("omp"));
    expect(OmpDriver.metadata.displayName).toBe("Oh My Pi");
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain(
      ProviderDriverKind.make("omp"),
    );
  });

  it("uses OMP-specific defaults", () => {
    expect(Schema.decodeSync(OmpSettings)(OmpDriver.defaultConfig())).toEqual({
      enabled: true,
      binaryPath: "omp",
      homePath: "",
      customModels: [],
    });
  });
});
