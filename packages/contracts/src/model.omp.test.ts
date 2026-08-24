import { expect, it } from "vite-plus/test";

import { PROVIDER_DISPLAY_NAMES } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

it("uses the Oh My Pi provider display name", () => {
  expect(PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make("omp")]).toBe("Oh My Pi");
});
