import { describe, expect, it, vi } from "vite-plus/test";

const expoConfigState = vi.hoisted(() => ({
  appVariant: undefined as string | undefined,
}));

vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return expoConfigState.appVariant === undefined
        ? undefined
        : { extra: { appVariant: expoConfigState.appVariant } };
    },
  },
}));

vi.mock("react-native", () => ({
  View: "View",
}));

vi.mock("./AppText", () => ({
  AppText: "Text",
}));

describe("BuildVariantBanner", () => {
  it("renders nothing for production", async () => {
    expoConfigState.appVariant = "production";
    const { BuildVariantBanner } = await import("./BuildVariantBanner");
    expect(BuildVariantBanner()).toBeNull();
  });

  it("renders development copy", async () => {
    expoConfigState.appVariant = "development";
    vi.resetModules();
    const { BuildVariantBanner } = await import("./BuildVariantBanner");
    const element = BuildVariantBanner() as { props: { testID: string; children: unknown } };
    expect(element.props.testID).toBe("build-variant-banner-development");
  });

  it("renders preview copy", async () => {
    expoConfigState.appVariant = "preview";
    vi.resetModules();
    const { BuildVariantBanner } = await import("./BuildVariantBanner");
    const element = BuildVariantBanner() as { props: { testID: string } };
    expect(element.props.testID).toBe("build-variant-banner-preview");
  });
});
