import {
  PullRequestListInput,
  SourceControlProviderKind,
  type EnvironmentId,
  type ProjectId,
  type PullRequestProviderSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  assignProjectsToEnvironments,
  rememberPullRequestHosts,
  resetPullRequestHosts,
  pullRequestProjectQueries,
  resolvePickableEnvironments,
  type AssignableProject,
} from "./pullRequestProjectAssignment.logic";

const project = (
  id: string,
  environmentId: string,
  canonicalKey?: string,
): AssignableProject & { workspaceRoot: string } => ({
  id: id as ProjectId,
  environmentId: environmentId as EnvironmentId,
  repositoryIdentity: canonicalKey === undefined ? null : { canonicalKey },
  workspaceRoot: `/srv/${environmentId}/${id}`,
});

const envs = (...ids: ReadonlyArray<string>) => ids as ReadonlyArray<EnvironmentId>;

const plain = (assignment: Map<EnvironmentId, ProjectId[]>) =>
  Object.fromEntries([...assignment].map(([id, projectIds]) => [id, projectIds]));
const decodeListInput = Schema.decodeSync(PullRequestListInput);

const hostAvailability = (hosts: ReadonlyMap<string, boolean>) => ({
  hosts: new Map([...hosts].map(([host, configured]) => [host, { configured, observedAt: 0 }])),
  projectHosts: new Map<ProjectId, { host: string; observedAt: number }>(),
});

const provider = (host: string, configured: boolean): PullRequestProviderSummary => ({
  host,
  kind: "bitbucket" as PullRequestProviderSummary["kind"],
  searchesOnHost: false,
  projectCount: 1,
  configured,
  detail: configured ? null : "Credentials rejected",
});

describe("host read results", () => {
  const environmentId = "env-1" as EnvironmentId;

  it("remembers a failed host after the assignment stops requesting it", () => {
    const failed = rememberPullRequestHosts(new Map(), [
      [environmentId, { providers: [provider("BITBUCKET.org", false)] }, 100],
    ]);
    const next = rememberPullRequestHosts(failed, [
      [environmentId, { providers: [provider("github.com", true)] }, 200],
    ]);
    expect(
      [...next.get(environmentId)!.hosts].map(([host, read]) => [host, read.configured]),
    ).toEqual([
      ["bitbucket.org", false],
      ["github.com", true],
    ]);
    expect(
      [...failed.get(environmentId)!.hosts].map(([host, read]) => [host, read.configured]),
    ).toEqual([["bitbucket.org", false]]);
  });

  it("does not replay cached failures after refresh clears availability", () => {
    const cleared = new Map([
      [
        environmentId,
        { observedAt: 100, resetAt: 100, ...hostAvailability(new Map<string, boolean>()) },
      ],
    ]);
    expect(
      rememberPullRequestHosts(cleared, [
        [environmentId, { providers: [provider("bitbucket.org", false)] }, 100],
      ]),
    ).toBe(cleared);
    const refreshed = rememberPullRequestHosts(cleared, [
      [environmentId, { providers: [provider("bitbucket.org", true)] }, 200],
    ]);
    expect(refreshed.get(environmentId)!.hosts.get("bitbucket.org")?.configured).toBe(true);
  });

  it("ignores an older answer when a newer read has already succeeded", () => {
    const readable = rememberPullRequestHosts(new Map(), [
      [environmentId, { providers: [provider("bitbucket.org", true)] }, 200],
    ]);
    expect(
      rememberPullRequestHosts(readable, [
        [environmentId, { providers: [provider("bitbucket.org", false)] }, 100],
      ]),
    ).toBe(readable);
  });

  it("remembers each project's resolved host when a later read omits it", () => {
    const projectId = "ssh" as ProjectId;
    const first = rememberPullRequestHosts(new Map(), [
      [
        environmentId,
        { providers: [{ ...provider("FORGE.example:3000", false), projectIds: [projectId] }] },
        100,
      ],
    ]);
    const next = rememberPullRequestHosts(first, [
      [environmentId, { providers: [provider("forge.example:4000", true)] }, 200],
    ]);
    expect(next.get(environmentId)!.projectHosts.get(projectId)?.host).toBe("forge.example:3000");
    expect(next.get(environmentId)!.hosts.get("forge.example:3000")?.configured).toBe(false);
    expect(next.get(environmentId)!.hosts.get("forge.example:4000")?.configured).toBe(true);
  });

  it("accepts another host's older batch without replacing a newer host read", () => {
    const first = rememberPullRequestHosts(new Map(), [
      [environmentId, { providers: [provider("github.com", true)] }, 200],
    ]);
    const next = rememberPullRequestHosts(first, [
      [environmentId, { providers: [provider("bitbucket.org", false)] }, 100],
    ]);
    expect(next.get(environmentId)!.hosts.get("bitbucket.org")?.configured).toBe(false);
    expect(next.get(environmentId)!.hosts.get("github.com")?.configured).toBe(true);
    expect(
      rememberPullRequestHosts(next, [
        [environmentId, { providers: [provider("github.com", false)] }, 150],
      ]),
    ).toBe(next);
  });

  it("does not replace a project's newer host mapping with an older batch", () => {
    const projectId = "ssh" as ProjectId;
    const first = rememberPullRequestHosts(new Map(), [
      [
        environmentId,
        { providers: [{ ...provider("forge.example:3000", false), projectIds: [projectId] }] },
        200,
      ],
    ]);
    const next = rememberPullRequestHosts(first, [
      [
        environmentId,
        { providers: [{ ...provider("forge.example:4000", true), projectIds: [projectId] }] },
        100,
      ],
    ]);
    expect(next.get(environmentId)!.projectHosts.get(projectId)?.host).toBe("forge.example:3000");
  });

  it.each([false, true])(
    "treats a host as readable when any active batch succeeds (reversed: %s)",
    (reverse) => {
      const observations = [
        [environmentId, { providers: [provider("gitlab.example", true)] }, 100],
        [environmentId, { providers: [provider("gitlab.example", false)] }, 200],
      ] as const;
      const next = rememberPullRequestHosts(
        new Map(),
        reverse ? observations.toReversed() : observations,
      );
      expect(next.get(environmentId)!.hosts.get("gitlab.example")).toEqual({
        configured: true,
        observedAt: 200,
      });
      expect(next.get(environmentId)!.observedAt).toBe(200);
      const cleared = resetPullRequestHosts(next);
      expect(rememberPullRequestHosts(cleared, observations)).toBe(cleared);
      const failed = rememberPullRequestHosts(next, [
        [environmentId, { providers: [provider("gitlab.example", false)] }, 300],
      ]);
      expect(failed.get(environmentId)!.hosts.get("gitlab.example")?.configured).toBe(false);
    },
  );

  it("forgets a refined host on refresh when the server returns to the stored identity", () => {
    const projects = [
      project("ssh", "env-1", "forge.example/acme/app"),
      project("copy", "env-2", "forge.example/acme/app"),
    ];
    const oldRead = [
      environmentId,
      { providers: [{ ...provider("forge.example:3000", true), projectIds: [projects[0]!.id] }] },
      100,
    ] as const;
    const previous = rememberPullRequestHosts(new Map(), [oldRead]);
    const cleared = resetPullRequestHosts(previous);
    expect(rememberPullRequestHosts(cleared, [oldRead])).toBe(cleared);
    const refreshed = rememberPullRequestHosts(cleared, [
      [environmentId, { providers: [provider("forge.example", false)] }, 200],
    ]);
    expect(
      plain(
        assignProjectsToEnvironments(projects, envs("env-1", "env-2"), environmentId, refreshed),
      ),
    ).toEqual({ "env-2": ["copy"] });
  });

  it("accepts a readable batch that arrives after a newer failed batch", () => {
    const failedRead = [
      environmentId,
      { providers: [provider("gitlab.example", false)] },
      200,
    ] as const;
    const failed = rememberPullRequestHosts(new Map(), [failedRead]);
    const reads = [
      failedRead,
      [environmentId, { providers: [provider("gitlab.example", true)] }, 100] as const,
    ];
    const readable = rememberPullRequestHosts(failed, reads);
    expect(readable.get(environmentId)!.hosts.get("gitlab.example")?.configured).toBe(true);
    expect(rememberPullRequestHosts(readable, reads)).toBe(readable);
  });
});

describe("assignment query limits", () => {
  it("retains every worktree's credential root in bounded partial batches", () => {
    const healthy = Array.from({ length: 101 }, (_, index) =>
      project(`healthy-${index}`, "env-1", `github.com/acme/repo-${index}`),
    );
    const worktrees = Array.from({ length: 101 }, (_, index) =>
      project(`worktree-${index}`, "env-1", "GITHUB.COM/ACME/REPO-0"),
    );
    const projects = [
      project("shared", "env-1", "bitbucket.org/acme/app"),
      ...healthy,
      ...worktrees,
      project("unknown", "env-1"),
      project("other-unknown", "env-1"),
      project("copy", "env-2", "bitbucket.org/acme/app"),
    ];
    const queries = pullRequestProjectQueries(
      projects,
      envs("env-1", "env-2"),
      new Map([["env-1" as EnvironmentId, hostAvailability(new Map([["bitbucket.org", false]]))]]),
    );
    const own = queries.filter(({ environmentId }) => environmentId === "env-1");
    expect(own.map(({ projectIds }) => projectIds?.length)).toEqual([100, 100, 4]);
    expect(own.flatMap(({ projectIds }) => projectIds ?? [])).toEqual([
      ...healthy.map(({ id }) => id),
      ...worktrees.map(({ id }) => id),
      "unknown",
      "other-unknown",
    ]);
    for (const { projectIds } of queries)
      expect(() =>
        decodeListInput({ state: "open", ...(projectIds === undefined ? {} : { projectIds }) }),
      ).not.toThrow();
  });

  it("splits the healthy remainder after fallback into valid project filters", () => {
    const healthy = Array.from({ length: 101 }, (_, index) =>
      project(`healthy-${index}`, "env-1", `github.com/acme/repo-${index}`),
    );
    const projects = [
      project("shared", "env-1", "bitbucket.org/acme/app"),
      ...healthy,
      project("copy", "env-2", "bitbucket.org/acme/app"),
    ];
    const queries = pullRequestProjectQueries(
      projects,
      envs("env-1", "env-2"),
      new Map([["env-1" as EnvironmentId, hostAvailability(new Map([["bitbucket.org", false]]))]]),
    );
    expect(
      queries.map(({ environmentId, projectIds }) => [environmentId, projectIds?.length]),
    ).toEqual([
      ["env-1", 100],
      ["env-1", 1],
      ["env-2", undefined],
    ]);
    expect(
      queries
        .filter(({ environmentId }) => environmentId === "env-1")
        .flatMap(({ projectIds }) => projectIds ?? []),
    ).toEqual(healthy.map(({ id }) => id));
    for (const { projectIds } of queries)
      expect(() =>
        decodeListInput({
          state: "open",
          ...(projectIds === undefined ? {} : { projectIds }),
        }),
      ).not.toThrow();
  });

  it("keeps an unfiltered read when a large server owns all its projects", () => {
    const projects = Array.from({ length: 102 }, (_, index) =>
      project(`p-${index}`, "env-1", `github.com/acme/repo-${index}`),
    );
    expect(pullRequestProjectQueries(projects, envs("env-1"))).toEqual([
      { environmentId: "env-1" },
    ]);
  });
});

describe("one server per repository", () => {
  it("lets the first server list a repository both hold", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("b1", "env-1", "github.com/acme/tools"),
        project("a2", "env-2", "github.com/acme/app"),
        project("c2", "env-2", "github.com/acme/site"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1", "b1"], "env-2": ["c2"] });
  });

  it("prefers the named server over the first one", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-2" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-2": ["a2"] });
  });

  it("falls back from an unreadable host without moving other repositories", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "bitbucket.org/acme/app"),
        project("b1", "env-1", "github.com/acme/tools"),
        project("a2", "env-2", "bitbucket.org/acme/app"),
        project("b2", "env-2", "github.com/acme/tools"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
      new Map([["env-1" as EnvironmentId, hostAvailability(new Map([["bitbucket.org", false]]))]]),
    );
    expect(plain(assignment)).toEqual({ "env-1": ["b1"], "env-2": ["a2"] });
  });

  it("tries the next server when its host has not been read yet", () => {
    const projects = [
      project("a1", "env-1", "git.example.com/acme/app"),
      project("a2", "env-2", "git.example.com/acme/app"),
      project("a3", "env-3", "git.example.com/acme/app"),
    ];
    const availability = new Map([
      ["env-1" as EnvironmentId, hostAvailability(new Map([["git.example.com", false]]))],
    ]);
    expect(
      plain(
        assignProjectsToEnvironments(projects, envs("env-1", "env-2", "env-3"), null, availability),
      ),
    ).toEqual({ "env-2": ["a2"] });
    availability.set(
      "env-2" as EnvironmentId,
      hostAvailability(new Map([["git.example.com", false]])),
    );
    expect(
      plain(
        assignProjectsToEnvironments(projects, envs("env-1", "env-2", "env-3"), null, availability),
      ),
    ).toEqual({ "env-3": ["a3"] });
  });

  it("keeps one stable owner and its error when every copy is unreadable", () => {
    const projects = [
      project("a1", "env-1", "bitbucket.org/acme/app"),
      project("a2", "env-2", "bitbucket.org/acme/app"),
      project("only1", "env-1", "bitbucket.org/acme/only"),
    ];
    const availability = new Map(
      envs("env-1", "env-2").map((id) => [
        id,
        hostAvailability(new Map([["bitbucket.org", false]])),
      ]),
    );
    expect(
      plain(
        assignProjectsToEnvironments(
          projects,
          envs("env-1", "env-2"),
          "env-1" as EnvironmentId,
          availability,
        ),
      ),
    ).toEqual({ "env-1": ["a1", "only1"] });
    expect(
      plain(
        assignProjectsToEnvironments(
          projects,
          envs("env-2"),
          "env-2" as EnvironmentId,
          availability,
        ),
      ),
    ).toEqual({ "env-2": ["a2"] });
  });

  it("drops a server with nothing of its own", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(assignment.has("env-2" as EnvironmentId)).toBe(false);
  });

  it("checks the owner's HTTP authority using its own identity in either project order", () => {
    const projects = [
      {
        ...project("a1", "env-1", "forge.example/team/repo"),
        repositoryIdentity: {
          canonicalKey: "forge.example/team/repo",
          provider: SourceControlProviderKind.make("forgejo"),
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://forge.example:3000/team/repo.git",
          },
        },
      },
      {
        ...project("a2", "env-2", "forge.example/team/repo"),
        repositoryIdentity: {
          canonicalKey: "forge.example/team/repo",
          provider: SourceControlProviderKind.make("forgejo"),
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@forge.example:team/repo.git",
          },
        },
      },
    ] as const;
    const availability = new Map([
      ["env-1" as EnvironmentId, hostAvailability(new Map([["forge.example:3000", false]]))],
    ]);
    for (const copies of [projects, projects.toReversed()]) {
      expect(
        plain(
          assignProjectsToEnvironments(
            copies,
            envs("env-1", "env-2"),
            "env-1" as EnvironmentId,
            availability,
          ),
        ),
      ).toEqual({ "env-2": ["a2"] });
    }
  });

  it("uses a server-resolved host for SSH without conflating ports on that host", () => {
    const projects = envs("env-1", "env-2").map((environmentId) => ({
      ...project(`a-${environmentId}`, environmentId, "ssh.forge.example/team/repo"),
      repositoryIdentity: {
        canonicalKey: "ssh.forge.example/team/repo",
        provider: SourceControlProviderKind.make("forgejo"),
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "ssh://git@ssh.forge.example:2222/team/repo.git",
        },
      },
    }));
    const availability = rememberPullRequestHosts(new Map(), [
      [
        "env-1" as EnvironmentId,
        {
          providers: [
            { ...provider("forge.example:3000", false), projectIds: ["a-env-1" as ProjectId] },
            { ...provider("forge.example:4000", true), projectIds: ["unrelated" as ProjectId] },
          ],
        },
        100,
      ],
    ]);
    for (const copies of [projects, projects.toReversed()]) {
      expect(
        plain(
          assignProjectsToEnvironments(
            copies,
            envs("env-1", "env-2"),
            "env-1" as EnvironmentId,
            availability,
          ),
        ),
      ).toEqual({ "env-2": ["a-env-2"] });
    }
  });

  it("keeps every copy of a project that has no identity to compare", () => {
    const assignment = assignProjectsToEnvironments(
      [project("p1", "env-1"), project("p2", "env-2")],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["p1"], "env-2": ["p2"] });
  });

  it("keeps a server's own worktrees of the repository it lists", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a1-wt", "env-1", "GitHub.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1", "a1-wt"] });
  });

  it("reads two servers' copies of one repository as one however the remote is cased", () => {
    const assignment = assignProjectsToEnvironments(
      [
        project("a1", "env-1", "git.example.com/Team/App"),
        project("a2", "env-2", "GIT.example.com/team/app"),
      ],
      envs("env-1", "env-2"),
      "env-1" as EnvironmentId,
    );
    expect(plain(assignment)).toEqual({ "env-1": ["a1"] });
  });

  it("answers the same whatever order the projects arrive in", () => {
    const projects = [
      project("a2", "env-2", "github.com/acme/app"),
      project("a1", "env-1", "github.com/acme/app"),
    ];
    const forward = assignProjectsToEnvironments(projects, envs("env-1", "env-2"), null);
    const backward = assignProjectsToEnvironments(
      projects.toReversed(),
      envs("env-1", "env-2"),
      null,
    );
    expect(plain(forward)).toEqual({ "env-1": ["a1"] });
    expect(plain(backward)).toEqual(plain(forward));
  });
});

const connected = (...ids: ReadonlyArray<string>) =>
  ids.map((id) => ({ environmentId: id as EnvironmentId, label: `Server ${id}` }));

const on = (environmentId: string, projectId: string) => ({
  environmentId: environmentId as EnvironmentId,
  projectId: projectId as ProjectId,
});

describe("where a pull request can be acted on", () => {
  it("offers every server holding the repository, the panel's own first", () => {
    const pickable = resolvePickableEnvironments(
      on("env-2", "a2"),
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
        project("c3", "env-3", "github.com/acme/site"),
      ],
      connected("env-1", "env-2", "env-3"),
    );
    expect(pickable).toEqual([
      {
        environmentId: "env-2",
        projectId: "a2",
        workspaceRoot: "/srv/env-2/a2",
        label: "Server env-2",
      },
      {
        environmentId: "env-1",
        projectId: "a1",
        workspaceRoot: "/srv/env-1/a1",
        label: "Server env-1",
      },
    ]);
  });

  it("names one copy per server, so two worktrees are one choice", () => {
    const pickable = resolvePickableEnvironments(
      on("env-1", "a1"),
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a1-wt", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
        project("a2-wt", "env-2", "github.com/acme/app"),
      ],
      connected("env-1", "env-2"),
    );
    expect(pickable.map((entry) => entry.projectId)).toEqual(["a1", "a2"]);
  });

  it("keeps the panel's own worktree rather than the server's first copy", () => {
    const pickable = resolvePickableEnvironments(
      on("env-1", "a1-wt"),
      [
        project("a1", "env-1", "github.com/acme/app"),
        project("a1-wt", "env-1", "github.com/acme/app"),
        project("a2", "env-2", "github.com/acme/app"),
      ],
      connected("env-1", "env-2"),
    );
    expect(pickable[0]).toEqual({
      environmentId: "env-1",
      projectId: "a1-wt",
      workspaceRoot: "/srv/env-1/a1-wt",
      label: "Server env-1",
    });
  });
});
