import { expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

it("registers Pi as a built-in provider driver", () => {
  expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("pi");
});
