import { ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { findMoveTargetProject } from "./threadMove.ts";

const repo = (canonicalKey: string): RepositoryIdentity => ({
  canonicalKey,
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${canonicalKey}` },
});

const project = (id: string, key: string | null) => ({
  id: ProjectId.make(id),
  repositoryIdentity: key === null ? null : repo(key),
});

describe("findMoveTargetProject", () => {
  it("matches the target project for the same repository, ignoring case", () => {
    const target = project("there", "github.com/acme/app");
    expect(
      findMoveTargetProject(project("here", "github.com/Acme/App"), [
        project("other", "github.com/acme/other"),
        target,
      ]),
    ).toBe(target);
  });

  it("does not guess between several matches or without a repository", () => {
    expect(
      findMoveTargetProject(project("here", "github.com/acme/app"), [
        project("a", "github.com/acme/app"),
        project("b", "github.com/acme/app"),
      ]),
    ).toBeNull();
    expect(findMoveTargetProject(project("here", null), [project("a", null)])).toBeNull();
  });
});
