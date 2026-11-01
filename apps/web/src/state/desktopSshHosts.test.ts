import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterDiscoveredSshHosts } from "./desktopSshHosts";

describe("filterDiscoveredSshHosts", () => {
  const suggestions: ReadonlyArray<DesktopDiscoveredSshHost> = [
    {
      alias: "grape",
      hostname: "grape",
      port: null,
      source: "known-hosts",
      username: null,
    },
    {
      alias: "Pinot",
      hostname: "Pinot",
      port: null,
      source: "ssh-config",
      username: null,
    },
    {
      alias: "preprod",
      hostname: "preprod",
      port: 2222,
      source: "ssh-config",
      username: "deploy",
    },
    {
      alias: "prod-z",
      hostname: "prod-z",
      port: null,
      source: "ssh-config",
      username: null,
    },
    {
      alias: "prod-a",
      hostname: "prod-a",
      port: null,
      source: "ssh-config",
      username: null,
    },
    {
      alias: "prod-m",
      hostname: "prod-m",
      port: null,
      source: "ssh-config",
      username: null,
    },
  ];

  it("ranks alias prefix matches before substring matches", () => {
    expect(filterDiscoveredSshHosts(suggestions, "prod")).toEqual([
      suggestions[3],
      suggestions[4],
      suggestions[5],
      suggestions[2],
    ]);
  });
});
