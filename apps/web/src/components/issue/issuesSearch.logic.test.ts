import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { issueFilterProjects, issueListTargets, issuesSearchFromUrl } from "./issuesSearch.logic";

describe("issuesSearchFromUrl", () => {
  it("replaces a malformed filter instead of letting the raw value through", () => {
    // The router lays the validated keys over the raw search, so a key left out keeps its raw value.
    const raw = { label: true, order: "oldest", assignee: "   ", host: true };
    const search = { ...raw, ...issuesSearchFromUrl(raw) };
    expect(search.host).toBeUndefined();
    expect(search.label).toBeUndefined();
    expect(search.assignee).toBeUndefined();
    expect(search.order).toBeUndefined();
    expect(issuesSearchFromUrl({ label: "bug" }).label).toEqual(["bug"]);
    expect(issuesSearchFromUrl({ label: ["bug", " ui "], order: "created" })).toMatchObject({
      label: ["bug", "ui"],
      order: "created",
    });
    expect(
      issuesSearchFromUrl({ hideProjects: [["env", "web"], ["env"], "api", ["env", 3]] })
        .hideProjects,
    ).toEqual([
      ["env", "web"],
      ["env", "3"],
    ]);
  });

  it("cuts a long search before an emoji the limit would split", () => {
    expect(issuesSearchFromUrl({ q: `${"a".repeat(199)}😀 rest` }).q).toBe("a".repeat(199));
  });
});

describe("issueListTargets", () => {
  it("leaves hidden projects out and skips an environment with every project hidden", () => {
    const laptop = EnvironmentId.make("laptop");
    const vps = EnvironmentId.make("vps");
    const projects = [
      { environmentId: laptop, id: ProjectId.make("web") },
      { environmentId: laptop, id: ProjectId.make("api") },
      { environmentId: vps, id: ProjectId.make("docs") },
    ];
    const input = { state: "open" } as const;
    const hidden = [
      [laptop, ProjectId.make("api")],
      [laptop, ProjectId.make("removed")],
      [vps, ProjectId.make("docs")],
    ] as const;
    expect(issueListTargets([laptop, vps], projects, hidden, input)).toEqual([
      { environmentId: laptop, input: { state: "open", excludeProjectIds: ["api"] } },
    ]);
    // Before the project list loads, the saved choice still leaves its projects out.
    expect(issueListTargets([laptop, vps], [], hidden, input)).toEqual([
      { environmentId: laptop, input: { state: "open", excludeProjectIds: ["api", "removed"] } },
      { environmentId: vps, input: { state: "open", excludeProjectIds: ["docs"] } },
    ]);
    expect(issueListTargets([laptop, vps], projects, undefined, input)).toEqual([
      { environmentId: laptop, input },
      { environmentId: vps, input },
    ]);
  });
});

describe("issueFilterProjects", () => {
  it("lists one repository once across environments and checkouts, scratch stays separate", () => {
    const laptop = EnvironmentId.make("laptop");
    const vps = EnvironmentId.make("vps");
    const project = (
      id: string,
      environmentId: EnvironmentId,
      isScratch = false,
      title = "t3code",
      canonicalKey = "github.com/pingdotgg/t3code",
    ) =>
      ({
        id: ProjectId.make(id),
        environmentId,
        title,
        workspaceRoot: `/work/${id}`,
        repositoryIdentity: { canonicalKey },
        isScratch,
      }) as unknown as EnvironmentProject;
    const choices = issueFilterProjects(
      [
        project("main", laptop),
        project("worktree", laptop),
        project("main", vps),
        project("other", laptop, false, "other", "github.com/acme/other"),
        project("scratch", laptop, true),
      ],
      new Map([
        [laptop, "laptop"],
        [vps, "vps"],
      ]),
    );
    const key = (environmentId: EnvironmentId, id: string) =>
      JSON.stringify([environmentId, ProjectId.make(id)]);
    expect(choices.map((choice) => [choice.title, choice.memberProjectKeys])).toEqual([
      ["other", [key(laptop, "other")]],
      [
        "t3code · laptop · /work/main",
        [key(laptop, "main"), key(laptop, "worktree"), key(vps, "main")],
      ],
      ["t3code · laptop · /work/scratch", [key(laptop, "scratch")]],
    ]);
  });

  it("groups case variants of one repository into a single choice", () => {
    const laptop = EnvironmentId.make("laptop");
    const vps = EnvironmentId.make("vps");
    const project = (id: string, environmentId: EnvironmentId, canonicalKey: string) =>
      ({
        id: ProjectId.make(id),
        environmentId,
        title: "t3code",
        workspaceRoot: `/work/${id}`,
        repositoryIdentity: { canonicalKey },
        isScratch: false,
      }) as unknown as EnvironmentProject;
    const choices = issueFilterProjects(
      [
        project("main", laptop, "github.com/PingDotGG/T3Code"),
        project("main", vps, "github.com/pingdotgg/t3code"),
      ],
      new Map([
        [laptop, "laptop"],
        [vps, "vps"],
      ]),
    );
    const key = (environmentId: EnvironmentId, id: string) =>
      JSON.stringify([environmentId, ProjectId.make(id)]);
    expect(choices).toHaveLength(1);
    expect(choices[0]?.memberProjectKeys).toEqual([key(laptop, "main"), key(vps, "main")]);
  });
});
