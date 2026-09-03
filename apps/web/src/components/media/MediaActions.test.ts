import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleNativeImageContextMenu,
  shouldUseNativeImageContextMenu,
  type MediaActionSource,
} from "./MediaActions";

const remoteImage: MediaActionSource = {
  kind: "image",
  name: "screenshot.png",
  src: "https://images.example/screenshot.png",
  reference: { kind: "url", url: "https://images.example/screenshot.png" },
};

describe("shouldUseNativeImageContextMenu", () => {
  it("keeps direct external images on the browser-native menu", () => {
    expect(shouldUseNativeImageContextMenu(remoteImage)).toBe(true);
  });

  it("keeps environment assets on the custom source-aware menu", () => {
    expect(
      shouldUseNativeImageContextMenu({
        ...remoteImage,
        asset: {} as NonNullable<MediaActionSource["asset"]>,
      }),
    ).toBe(false);
  });

  it("keeps videos on the custom source-aware menu", () => {
    expect(shouldUseNativeImageContextMenu({ ...remoteImage, kind: "video" })).toBe(false);
  });

  it("stops linked-image ancestors without preventing the native menu", () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    expect(
      handleNativeImageContextMenu(remoteImage, {
        defaultPrevented: false,
        preventDefault,
        stopPropagation,
      }),
    ).toBe(true);
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
