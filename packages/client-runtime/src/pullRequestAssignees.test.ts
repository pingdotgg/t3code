import { describe, expect, it } from "@effect/vitest";

import { mergeAssigneeCandidates } from "./pullRequestAssignees.ts";

const person = (login: string, isAssigned = false, name: string | null = null) => ({
  login,
  name,
  avatarUrl: null,
  id: login,
  isAssigned,
});

describe("mergeAssigneeCandidates", () => {
  it("narrows the loaded people by login or name", () => {
    const loaded = [person("ada"), person("grace", false, "Grace Hopper"), person("linus")];
    expect(mergeAssigneeCandidates(loaded, [], "HOP").map((entry) => entry.login)).toEqual([
      "grace",
    ]);
  });

  it("adds people only the host's search found, after the loaded ones", () => {
    const loaded = [person("ada"), person("adam")];
    const searched = [person("adam"), person("adalbert")];
    expect(mergeAssigneeCandidates(loaded, searched, "ada").map((entry) => entry.login)).toEqual([
      "ada",
      "adam",
      "adalbert",
    ]);
  });

  it("keeps the loaded entry for somebody both lists name, since assigning updates that one", () => {
    const loaded = [person("ada", true)];
    const searched = [person("ada", false)];
    expect(mergeAssigneeCandidates(loaded, searched, "ada")).toEqual([person("ada", true)]);
  });
});
