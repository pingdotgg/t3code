import { describe, expect, it } from "vite-plus/test";

import { resolveWebAssetBrandForPackageVersion } from "./brand-assets.ts";

describe("brand-assets", () => {
  it("maps package versions to web asset brands", () => {
    expect(resolveWebAssetBrandForPackageVersion("0.0.29")).toBe("production");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-nightly.20260723.882")).toBe("nightly");
    expect(resolveWebAssetBrandForPackageVersion("0.0.29-preview.20260723.882")).toBe("nightly");
  });
});
