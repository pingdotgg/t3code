import { expect, it } from "vite-plus/test";

import { getDriverOption } from "./providerDriverMeta.ts";

it("registers Pi as a selectable provider driver", () => {
  const pi = getDriverOption("pi" as never);

  expect(pi).toMatchObject({ label: "Pi", value: "pi" });
  expect(pi?.badgeLabel).toBeUndefined();
});
