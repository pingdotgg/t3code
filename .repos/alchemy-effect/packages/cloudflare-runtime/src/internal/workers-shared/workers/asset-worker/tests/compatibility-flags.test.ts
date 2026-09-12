// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { describe, test } from "vitest";
import { resolveCompatibilityOptions } from "../src/compatibility-flags.ts";

describe("resolveCompatibilityOptions", () => {
  test("it does not interfere with existing flags", ({ expect }) => {
    expect(resolveCompatibilityOptions({ compatibility_flags: ["foo", "bar"] }))
      .toMatchInlineSnapshot(`
			{
			  "compatibilityDate": "2021-11-02",
			  "compatibilityFlags": [
			    "foo",
			    "bar",
			  ],
			}
		`);
  });

  test("it opts you into new flags if you have a future date", ({ expect }) => {
    const { compatibilityDate, compatibilityFlags } =
      resolveCompatibilityOptions({
        compatibility_flags: ["foo", "bar"],
        compatibility_date: "2099-12-12",
      });

    expect(compatibilityDate).toEqual("2099-12-12");
    expect(compatibilityFlags).toContain("foo");
    expect(compatibilityFlags).toContain("bar");
    expect(compatibilityFlags).toContain(
      "assets_navigation_prefers_asset_serving",
    );
  });

  test("it doesn't double you up if you've already opted into new flags and have a future date", ({
    expect,
  }) => {
    const { compatibilityDate, compatibilityFlags } =
      resolveCompatibilityOptions({
        compatibility_flags: [
          "foo",
          "bar",
          "assets_navigation_prefers_asset_serving",
        ],
        compatibility_date: "2099-12-12",
      });

    expect(compatibilityDate).toEqual("2099-12-12");
    expect(compatibilityFlags).toContain("foo");
    expect(compatibilityFlags).toContain("bar");
    expect(
      compatibilityFlags.filter(
        (flag) => flag === "assets_navigation_prefers_asset_serving",
      ).length,
    ).toBe(1);
  });

  test("it doesn't opt you into new flags if you have a future date and have disabled it", ({
    expect,
  }) => {
    const { compatibilityDate, compatibilityFlags } =
      resolveCompatibilityOptions({
        compatibility_flags: ["foo", "bar", "assets_navigation_has_no_effect"],
        compatibility_date: "2099-12-12",
      });

    expect(compatibilityDate).toEqual("2099-12-12");
    expect(compatibilityFlags).toContain("foo");
    expect(compatibilityFlags).toContain("bar");
    expect(compatibilityFlags).not.toContain(
      "assets_navigation_prefers_asset_serving",
    );
  });
});
