import { expect, it } from "vite-plus/test";

import { scripts } from "./slide-text";

it("asks for the Arabic fallback for an Arabic ligature, but not for a zero-width no-break space", () => {
  expect(scripts("Quarterly\uFEFF report")).toEqual([]);
  expect(scripts("Quarterly \uFEFC report")).toEqual(["arabic"]);
});
