import { describe, expect, it } from "@effect/vitest";

import { parseDarwinRecommendedUpdates, parseUpdateNotifier } from "./HostResources.ts";

describe("parseDarwinRecommendedUpdates", () => {
  it.each([
    {
      name: "counts updates but not optional major OS upgrades",
      json: JSON.stringify([
        { "Display Name": "Safari", "Display Version": "27.2", Identifier: "Safari27.2TahoeAuto" },
        {
          "Display Name": "macOS Tahoe 26.7.2",
          "Display Version": "26.7.2",
          Identifier: "MSU_UPDATE_25G332_patch_26.7.2_minor",
          MobileSoftwareUpdate: true,
        },
        {
          "Display Name": "macOS 27.2",
          "Display Version": "27.2",
          Identifier: "MSU_UPDATE_26B123_patch_27.2_major",
          MobileSoftwareUpdate: true,
        },
        { "Display Version": "1.0", Identifier: "Unnamed" },
      ]),
      expected: { available: 3, names: ["Safari 27.2", "macOS Tahoe 26.7.2"] },
    },
    { name: "an empty list is zero updates", json: "[]", expected: { available: 0, names: [] } },
    { name: "plutil found no key", json: "", expected: undefined },
    { name: "a non-array value", json: '{"a":1}', expected: undefined },
  ])("$name", ({ json, expected }) => {
    expect(parseDarwinRecommendedUpdates(json)).toEqual(expected);
  });
});

describe("parseUpdateNotifier", () => {
  it.each([
    {
      name: "Ubuntu 24.04 ignores ESM updates that cannot be applied",
      text: [
        "Expanded Security Maintenance for Applications is not enabled.",
        "",
        "136 updates can be applied immediately.",
        "To see these additional updates run: apt list --upgradable",
        "",
        "13 additional security updates can be applied with ESM Apps.",
      ].join("\n"),
      expected: { available: 136 },
    },
    {
      name: "standard security updates",
      text: "5 updates can be applied immediately.\n2 of these updates are standard security updates.\n",
      expected: { available: 5, security: 2 },
    },
    {
      name: "a single security update",
      text: "1 update can be applied immediately.\n1 of these updates is a standard security update.\n",
      expected: { available: 1, security: 1 },
    },
    {
      name: "pre-20.04 wording",
      text: "12 packages can be updated.\n3 updates are security updates.\n",
      expected: { available: 12, security: 3 },
    },
    { name: "no count", text: "", expected: undefined },
  ])("$name", ({ text, expected }) => {
    expect(parseUpdateNotifier(text)).toEqual(expected);
  });
});
