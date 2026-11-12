import { expect, it, vi } from "vite-plus/test";
import type { InstalledMobileFont } from "../lib/mobileFonts";

const native = vi.hoisted(() => ({
  resolveInstalledFonts: vi.fn<(names: readonly string[]) => Promise<InstalledMobileFont[]>>(),
  pickInstalledFont: vi.fn<() => Promise<InstalledMobileFont | null>>(),
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

async function setup() {
  vi.resetModules();
  native.resolveInstalledFonts.mockReset();
  native.pickInstalledFont.mockReset();
  return import("./installed-fonts");
}

it("does not request a missing font again until the user selects it in the picker", async () => {
  const fonts = await setup();
  const font = {
    name: "Removed-Regular",
    label: "Removed",
    regular: "Removed-Regular",
    medium: "Removed-Regular",
    bold: "Removed-Regular",
  };
  native.resolveInstalledFonts.mockResolvedValue([]);
  expect(await fonts.resolveInstalledFonts([font.name])).toEqual([]);
  expect(await fonts.resolveInstalledFonts([font.name])).toEqual([]);
  expect(native.resolveInstalledFonts).toHaveBeenCalledTimes(1);

  native.pickInstalledFont.mockResolvedValue(null);
  await fonts.pickInstalledFont(font.name);
  expect(await fonts.resolveInstalledFonts([font.name])).toEqual([]);
  expect(native.resolveInstalledFonts).toHaveBeenCalledTimes(1);

  native.pickInstalledFont.mockResolvedValue(font);
  await fonts.pickInstalledFont(font.name);
  native.resolveInstalledFonts.mockResolvedValue([font]);
  expect(await fonts.resolveInstalledFonts([font.name])).toEqual([font]);
  native.resolveInstalledFonts.mockResolvedValue([]);
  expect(await fonts.resolveInstalledFonts([font.name])).toEqual([]);
  expect(await fonts.resolveInstalledFonts([font.name])).toEqual([]);
  expect(native.resolveInstalledFonts).toHaveBeenCalledTimes(3);
});

it("shares an in-flight request and permits another attempt after a native failure", async () => {
  const fonts = await setup();
  const pending = Promise.withResolvers<InstalledMobileFont[]>();
  native.resolveInstalledFonts.mockReturnValue(pending.promise);
  const first = fonts.resolveInstalledFonts(["Removed-Regular"]);
  const second = fonts.resolveInstalledFonts(["Removed-Regular"]);
  const settled = Promise.allSettled([first, second]);
  pending.reject(new Error("Native request failed"));
  expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(native.resolveInstalledFonts).toHaveBeenCalledTimes(1);
  native.resolveInstalledFonts.mockResolvedValue([]);
  expect(await fonts.resolveInstalledFonts(["Removed-Regular"])).toEqual([]);
  expect(native.resolveInstalledFonts).toHaveBeenCalledTimes(2);
});
