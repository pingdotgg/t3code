import { describe, expect, test } from "vitest";

import { _internal } from "../../src/Cli/checkVersion";

const { pickDistTag } = _internal;

describe("pickDistTag", () => {
  // Real shape returned by https://registry.npmjs.org/-/package/alchemy/dist-tags
  const realDistTags = { latest: "0.93.7", next: "2.0.0-beta.33" };

  test("beta version picks the matching prerelease tag (next) over latest", () => {
    expect(pickDistTag("2.0.0-beta.30", realDistTags)).toBe("2.0.0-beta.33");
  });

  test("stable version picks latest", () => {
    expect(pickDistTag("0.93.6", realDistTags)).toBe("0.93.7");
  });

  test("prefers identifier-named tag when present", () => {
    expect(
      pickDistTag("2.0.0-beta.30", {
        latest: "0.93.7",
        next: "2.0.0-rc.1",
        beta: "2.0.0-beta.40",
      }),
    ).toBe("2.0.0-beta.40");
  });

  test("falls back to next when no identifier-named tag exists", () => {
    expect(
      pickDistTag("2.0.0-rc.1", { latest: "0.93.7", next: "2.0.0-rc.2" }),
    ).toBe("2.0.0-rc.2");
  });

  test("falls back to latest when no prerelease channel exists", () => {
    expect(pickDistTag("2.0.0-beta.30", { latest: "0.93.7" })).toBe("0.93.7");
  });
});
