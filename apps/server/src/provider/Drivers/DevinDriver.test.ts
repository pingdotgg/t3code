import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderDriverKind } from "@t3tools/contracts";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { DevinDriver } from "./DevinDriver.ts";

const isDevinConfig = Schema.is(DevinDriver.configSchema);

describe("DevinDriver", () => {
  it("is registered as a built-in driver", () => {
    expect(BUILT_IN_DRIVERS.includes(DevinDriver)).toBe(true);
  });

  it("has the devin driver kind", () => {
    expect(DevinDriver.driverKind).toBe(ProviderDriverKind.make("devin"));
  });

  it("exposes the DevinSettings schema and a valid default config", () => {
    const defaults = DevinDriver.defaultConfig();
    expect(isDevinConfig(defaults)).toBe(true);
    expect(defaults.enabled).toBe(false);
    expect(defaults.binaryPath).toBe("devin");
  });

  it("supports multiple instances", () => {
    expect(DevinDriver.metadata.supportsMultipleInstances).toBe(true);
  });
});
