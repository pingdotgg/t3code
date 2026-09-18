import {
  formatResourceTag,
  stripChildEffectPrefix,
} from "@/Util/ResourceOutput.ts";
import { describe, expect, it } from "alchemy-test";

describe("stripChildEffectPrefix", () => {
  it("removes an Effect pretty prefix", () => {
    expect(
      stripChildEffectPrefix(
        "[14:49:25.594] INFO (#1836): Cloudflare Worker reconcile: starting",
      ),
    ).toBe("Cloudflare Worker reconcile: starting");
  });

  it("removes a colored prefix without stripping message color", () => {
    expect(
      stripChildEffectPrefix(
        "\x1b[37m[14:49:25.594]\x1b[0m \x1b[32mINFO\x1b[0m (#1836): \x1b[36mmessage\x1b[0m",
      ),
    ).toBe("\x1b[36mmessage\x1b[0m");
  });

  it("leaves ordinary child output unchanged", () => {
    expect(stripChildEffectPrefix("vite building for production...")).toBe(
      "vite building for production...",
    );
  });
});

describe("formatResourceTag", () => {
  it("uses the Sigil info color when colors are enabled", () => {
    expect(formatResourceTag("Site/Worker", true)).toMatch(
      /^\x1b\[38;2;\d+;\d+;\d+m\[Site\/Worker\]\x1b\[0m$/,
    );
  });

  it("stays parseable when colors are disabled", () => {
    expect(formatResourceTag("Site/Worker", false)).toBe("[Site/Worker]");
  });
});
