import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../../orchestration-v2/builtInProviderAdapterDrivers.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PiDriver } from "./PiDriver.ts";

describe("PiDriver", () => {
  it("is a disabled-by-default first-party driver", () => {
    expect(PiDriver.driverKind).toBe(ProviderDriverKind.make("pi"));
    expect(PiDriver.defaultConfig()).toMatchObject({ enabled: false, binaryPath: "pi" });
    expect(BUILT_IN_DRIVERS).toContain(PiDriver);
    expect(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2).toContain(PiDriver.driverKind);
  });
});
