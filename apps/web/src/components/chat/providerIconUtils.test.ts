import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { KimiIcon } from "../Icons";
import { AVAILABLE_PROVIDER_OPTIONS, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("Kimi provider picker metadata", () => {
  it("makes Kimi selectable with the Kimi icon", () => {
    expect(AVAILABLE_PROVIDER_OPTIONS).toContainEqual({
      value: ProviderDriverKind.make("kimi"),
      label: "Kimi",
      available: true,
      pickerSidebarBadge: "new",
    });
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make("kimi")]).toBe(KimiIcon);
  });
});
