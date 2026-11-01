import { describe, expect, it } from "@effect/vitest";

import { mergeReviewerCandidates } from "./pullRequestReviewers.ts";

const reviewer = (
  login: string,
  { isRequested = false, name = null, kind = "user" } = {} as {
    isRequested?: boolean;
    name?: string | null;
    kind?: "user" | "team";
  },
) => ({ login, name, avatarUrl: null, id: login, kind, isRequested });

describe("mergeReviewerCandidates", () => {
  it("narrows the loaded candidates by login or name", () => {
    const loaded = [
      reviewer("ada"),
      reviewer("grace", { name: "Grace Hopper" }),
      reviewer("linus"),
    ];
    expect(mergeReviewerCandidates(loaded, [], "HOP").map((entry) => entry.login)).toEqual([
      "grace",
    ]);
  });

  it("adds candidates only the host's search found, after the loaded ones", () => {
    const loaded = [reviewer("ada"), reviewer("adam")];
    const searched = [reviewer("adam"), reviewer("adalbert")];
    expect(mergeReviewerCandidates(loaded, searched, "ada").map((entry) => entry.login)).toEqual([
      "ada",
      "adam",
      "adalbert",
    ]);
  });

  it("keeps the loaded entry for somebody both lists name, since a request updates that one", () => {
    const loaded = [reviewer("ada", { isRequested: true })];
    expect(mergeReviewerCandidates(loaded, [reviewer("ada")], "ada")).toEqual(loaded);
  });

  it("keeps a host match on a field absent from the loaded row", () => {
    const loaded = [reviewer("ada", { isRequested: true })];
    expect(mergeReviewerCandidates(loaded, [reviewer("ada")], "ada@example.com")).toEqual(loaded);
  });

  it("tells a team from a person sharing its id", () => {
    const loaded = [reviewer("core", { kind: "team", isRequested: true })];
    expect(
      mergeReviewerCandidates(loaded, [reviewer("core")], "core").map((entry) => entry.kind),
    ).toEqual(["team", "user"]);
  });
});
