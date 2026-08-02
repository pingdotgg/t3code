import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isModelPickerItemInSelectedScope } from "./modelPickerScope";

describe("isModelPickerItemInSelectedScope", () => {
  it("keeps duplicate model slugs scoped to the selected provider instance", () => {
    const favorites = new Set<string>();
    const openCodeModel = {
      instanceId: ProviderInstanceId.make("opencode"),
      slug: "opencode/glm-5.2",
    };
    const openCode2Model = {
      instanceId: ProviderInstanceId.make("opencode2"),
      slug: "opencode/glm-5.2",
    };

    expect(
      isModelPickerItemInSelectedScope(
        openCodeModel,
        ProviderInstanceId.make("opencode2"),
        favorites,
      ),
    ).toBe(false);
    expect(
      isModelPickerItemInSelectedScope(
        openCode2Model,
        ProviderInstanceId.make("opencode2"),
        favorites,
      ),
    ).toBe(true);
  });

  it("limits favorites search to favorited instance and model pairs", () => {
    const openCode2Model = {
      instanceId: ProviderInstanceId.make("opencode2"),
      slug: "opencode/big-pickle",
    };

    expect(
      isModelPickerItemInSelectedScope(
        openCode2Model,
        "favorites",
        new Set(["opencode2:opencode/big-pickle"]),
      ),
    ).toBe(true);
    expect(isModelPickerItemInSelectedScope(openCode2Model, "favorites", new Set())).toBe(false);
  });
});
