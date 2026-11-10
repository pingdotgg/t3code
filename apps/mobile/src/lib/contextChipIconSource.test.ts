import { describe, expect, it, vi } from "vite-plus/test";

import { modelChipIcon } from "./contextChipIconSource";

vi.mock("./contextChipIcons.generated", () => ({
  CONTEXT_CHIP_ICON_SOURCES: { bot: "bot.png" },
  PROVIDER_CHIP_ICONS: { codex: { source: "codex.png", tintsIcon: true } },
}));
vi.mock("./markdownFileIcons", () => ({
  markdownFileIconSource: vi.fn(),
  markdownIconAssetUri: vi.fn(),
}));

describe("modelChipIcon", () => {
  it("prefers a provider's own image, then its logo, then a generic glyph", () => {
    expect(modelChipIcon({ driver: "codex", iconUrl: "https://x.test/icon.png" })).toEqual({
      source: { uri: "https://x.test/icon.png" },
      tintsIcon: false,
    });
    expect(modelChipIcon({ driver: "codex" })).toEqual({ source: "codex.png", tintsIcon: true });
    expect(modelChipIcon({ driver: "unknown" })).toEqual({ source: "bot.png", tintsIcon: true });
  });

  it("never hands a native chip an SVG it cannot decode", () => {
    for (const iconUrl of [
      "https://cdn.agentclientprotocol.com/registry/v1/latest/devin.svg",
      "https://x.test/icon.SVG?v=2",
    ]) {
      expect(modelChipIcon({ driver: "acpRegistry", iconUrl })).toEqual({
        source: "bot.png",
        tintsIcon: true,
      });
    }
    expect(modelChipIcon({ driver: "codex", iconUrl: "https://x.test/icon.svg" })).toEqual({
      source: "codex.png",
      tintsIcon: true,
    });
  });
});
