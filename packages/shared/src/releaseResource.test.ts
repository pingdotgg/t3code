import { describe, expect, it } from "@effect/vitest";

import { releaseChannelOf, releaseResourceAttributes } from "./releaseResource.ts";

describe("releaseResourceAttributes", () => {
  it.each([
    ["dev", {}, "dev", "development"],
    ["stable", {}, "stable", "production"],
    ["nightly", {}, "nightly", "production"],
    ["preview", {}, "preview", "staging"],
    [
      "stable",
      { "deployment.environment.name": "staging", "t3code.release.channel": "" },
      "stable",
      "staging",
    ],
  ] as const)(
    "%s (operator: %o) reports %s in %s",
    (channel, operatorAttributes, expectedChannel, environment) => {
      expect(releaseResourceAttributes(channel, operatorAttributes)).toEqual({
        "t3code.release.channel": expectedChannel,
        "deployment.environment.name": environment,
      });
    },
  );

  it.each([
    ["0.1.2", "stable"],
    ["0.1.2-nightly.20261025.1", "nightly"],
    ["0.1.2-preview.20261025.1", "preview"],
    ["0.1.2-pr.24340.123", "preview"],
  ] as const)("classifies %s as %s", (version, channel) => {
    expect(releaseChannelOf(version)).toBe(channel);
  });
});
