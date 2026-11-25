import { dashboardIconUrl } from "@t3tools/shared/dashboardIcons";
import { describe, expect, it } from "vite-plus/test";

import { findDashboardIcons, parseDashboardIcons } from "./dashboardIcons";

const entries = parseDashboardIcons({
  github: {
    base: "svg",
    aliases: ["GitHub", "code-repository"],
    colors: { dark: "github", light: "github-light" },
  },
  docker: { base: "svg", aliases: [], colors: { light: "docker-light" } },
  plex: { base: "svg", aliases: [] },
  plexamp: { base: "png", aliases: [] },
  "home-assistant": { base: "svg", aliases: [] },
  homer: { base: "svg", aliases: [] },
  broken: { base: "gif" },
});
const names = (icons: ReadonlyArray<{ name: string }>) => icons.map(({ name }) => name);

describe("parseDashboardIcons", () => {
  it("keeps the file for each appearance and skips entries it cannot show", () => {
    const byName = new Map(entries.map(({ icon }) => [icon.name, icon]));
    const github = byName.get("github")!;
    expect(github).toEqual({
      kind: "dashboard-icon",
      name: "github",
      file: "github.svg",
      darkFile: "github-light.svg",
    });
    expect(byName.get("plexamp")).toEqual({
      kind: "dashboard-icon",
      name: "plexamp",
      file: "plexamp.png",
    });
    expect(byName.has("broken")).toBe(false);
    expect(dashboardIconUrl(github, "dark")).toBe(
      "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/github-light.svg",
    );
  });
});

describe("findDashboardIcons", () => {
  it("ranks exact names, then prefixes, then substrings and aliases", () => {
    expect(names(findDashboardIcons(entries, "plex", ""))).toEqual(["plex", "plexamp"]);
    expect(names(findDashboardIcons(entries, "Home Assistant", ""))).toEqual(["home-assistant"]);
    expect(names(findDashboardIcons(entries, "repository", ""))).toEqual(["github"]);
  });

  it("suggests icons named in the project name when there is no query", () => {
    expect(names(findDashboardIcons(entries, " ", "My Plex Server"))).toEqual(["plex", "plexamp"]);
    expect(names(findDashboardIcons(entries, "", "home-assistant-config"))).toEqual([
      "home-assistant",
      "homer",
    ]);
    expect(names(findDashboardIcons(entries, "", "github-actions-runner"))).toEqual(["github"]);
    expect(findDashboardIcons(entries, "", "zz")).toEqual([]);
  });
});
