import { describe, expect, it } from "@effect/vitest";

import { releaseResourceAttributes } from "./releaseResource.ts";

describe("releaseResourceAttributes", () => {
  it.each([
    ["1.2.3", true, "dev", "development"],
    ["1.2.3-nightly.20261023.4", true, "dev", "development"],
    ["1.2.3-preview.20261023.1", true, "dev", "development"],
    ["1.2.3", false, "stable", "production"],
    ["1.2.3-nightly.20261023.4", false, "nightly", "production"],
    ["1.2.3-preview.20261023.1", false, "preview", "staging"],
    ["1.2.3-rc.1", false, "stable", "production"],
  ] as const)(
    "derives %s (development: %s) as %s in %s",
    (version, isDevelopment, channel, env) => {
      expect(releaseResourceAttributes({ version, isDevelopment, operatorAttributes: {} })).toEqual(
        {
          "t3code.release.channel": channel,
          "deployment.environment.name": env,
        },
      );
    },
  );

  it("lets an operator value win for each key independently", () => {
    expect(
      releaseResourceAttributes({
        version: "1.2.3",
        isDevelopment: false,
        operatorAttributes: { "deployment.environment.name": "staging" },
      }),
    ).toEqual({ "t3code.release.channel": "stable", "deployment.environment.name": "staging" });
    expect(
      releaseResourceAttributes({
        version: "1.2.3",
        isDevelopment: false,
        operatorAttributes: { "t3code.release.channel": "nightly" },
      }),
    ).toEqual({ "t3code.release.channel": "nightly", "deployment.environment.name": "production" });
  });

  it("ignores empty or non-string operator values", () => {
    expect(
      releaseResourceAttributes({
        version: "1.2.3",
        isDevelopment: false,
        operatorAttributes: { "deployment.environment.name": "", "t3code.release.channel": 3 },
      }),
    ).toEqual({ "t3code.release.channel": "stable", "deployment.environment.name": "production" });
  });

  it("lets a build mark itself as a preview without changing its version", () => {
    expect(
      releaseResourceAttributes({
        version: "1.2.3",
        isDevelopment: false,
        operatorAttributes: {},
        channel: "preview",
      }),
    ).toEqual({ "t3code.release.channel": "preview", "deployment.environment.name": "staging" });
  });
});
