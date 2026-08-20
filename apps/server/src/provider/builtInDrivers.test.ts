import { expect, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

it("registers the Devin Cloud driver", () => {
  expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("devinCloud");
});
