import { describe, expect, it } from "vitest";
import cloudflare from "../cloudflare.ts";

describe("Vocs Cloudflare target", () => {
  it("adds nodejs_compat for the Vocs server runtime", () => {
    expect(
      cloudflare({
        worker: { compatibilityFlags: ["some_other_flag"] },
      }).config?.compatibilityFlags,
    ).toEqual(["some_other_flag", "nodejs_compat"]);
  });

  it("does not duplicate nodejs_compat", () => {
    expect(
      cloudflare({
        worker: { compatibilityFlags: ["nodejs_compat"] },
      }).config?.compatibilityFlags,
    ).toEqual(["nodejs_compat"]);
  });
});
