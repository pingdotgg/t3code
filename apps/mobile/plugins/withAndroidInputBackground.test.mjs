import { describe, expect, it } from "vitest";
import withAndroidInputBackground from "./withAndroidInputBackground.cjs";

async function transform(resources) {
  const config = withAndroidInputBackground({ name: "Test", slug: "test" });
  const result = await config.mods.android.styles({
    ...config,
    modRequest: { platform: "android", modName: "styles", introspect: false },
    modResults: { resources: structuredClone(resources) },
  });
  return result.modResults.resources;
}

describe("Android input background generation", () => {
  it("removes framework and AppCompat underlines while preserving other theme settings", async () => {
    const color = { $: { name: "colorPrimary" }, _: "@color/colorPrimary" };
    const dialog = { $: { name: "AppAlertDialog" }, item: [color] };
    const result = await transform({
      style: [
        {
          $: { name: "AppTheme", parent: "Theme.AppCompat.DayNight.NoActionBar" },
          item: [
            color,
            { $: { name: "android:editTextBackground" }, _: "@drawable/rn_edit_text_material" },
          ],
        },
        dialog,
      ],
    });

    expect(result.style[0]).toEqual({
      $: { name: "AppTheme", parent: "Theme.AppCompat.DayNight.NoActionBar" },
      item: [
        color,
        { $: { name: "android:editTextBackground" }, _: "@null" },
        { $: { name: "editTextBackground" }, _: "@null" },
      ],
    });
    expect(result.style[1]).toEqual(dialog);
    expect(await transform(result)).toEqual(result);
  });

  it("handles a theme with no existing items", async () => {
    const result = await transform({ style: [{ $: { name: "AppTheme" } }] });
    expect(result.style[0].item).toEqual([
      { $: { name: "editTextBackground" }, _: "@null" },
      { $: { name: "android:editTextBackground" }, _: "@null" },
    ]);
  });

  it("fails visibly if the Android theme template changes", async () => {
    await expect(transform({})).rejects.toThrow("AppTheme is missing");
  });
});
