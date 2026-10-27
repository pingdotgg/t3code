import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { normalizeProviderIconUrl, ProviderInstanceConfig } from "./providerInstance.ts";

const decodeInstance = Schema.decodeUnknownSync(ProviderInstanceConfig);
const encodeInstance = Schema.encodeSync(ProviderInstanceConfig);

describe("provider instance icons", () => {
  it("round trips an icon independently of the driver config", () => {
    const instance = decodeInstance({
      driver: "acpRegistry",
      iconUrl: "https://example.com/hermes.png",
      config: { source: "local", commandPath: "hermes", args: ["acp"] },
    });
    expect(encodeInstance(instance)).toEqual(instance);
    expect(normalizeProviderIconUrl("  https://example.com/hermes.png  ")).toBe(instance.iconUrl);
  });

  it.each([
    "",
    "file:///tmp/icon.png",
    "javascript:alert(1)",
    "data:image/png;base64,abc",
    "http://example.com/icon.png",
    "https://user:secret@example.com/icon.png",
    `https://example.com/${"x".repeat(2048)}`,
  ])("rejects an unusable icon URL %s", (iconUrl) => {
    expect(normalizeProviderIconUrl(iconUrl)).toBeNull();
    expect(() => decodeInstance({ driver: "codex", iconUrl })).toThrow();
  });

  it("accepts existing instances without an icon", () => {
    expect(decodeInstance({ driver: "codex" }).iconUrl).toBeUndefined();
  });
});
