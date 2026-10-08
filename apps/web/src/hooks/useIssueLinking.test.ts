import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { findThreadIssueLink, resolveIssueUrl, useIssueLinking } from "./useIssueLinking";

const mocks = vi.hoisted(() => ({
  configs: vi.fn(),
  projects: vi.fn(),
  thread: vi.fn(),
  detail: vi.fn(),
  update: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: (create: () => unknown) => create(),
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: mocks.configs,
  useProjects: mocks.projects,
  readThreadShell: mocks.thread,
}));
vi.mock("~/state/issues", () => ({ issueEnvironment: { detail: "detail" } }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { updateMetadata: "metadata" } }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.detail }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));

const project = (id: string, canonicalKey: string, provider: string, displayName: string) =>
  ({
    id,
    environmentId: "env",
    repositoryIdentity: { canonicalKey, provider, displayName },
  }) as EnvironmentProject;

const projects = [
  project("web", "github.com/acme/web", "github", "acme/web"),
  project("api", "gitlab.example.com/team/api", "gitlab", "team/api"),
  project("ado", "dev.azure.com/org/project/repo", "azure-devops", "org/project/repo"),
];

const resolve = (url: string, linearBindings?: Record<string, { repository: string }>) =>
  resolveIssueUrl({
    url,
    projects,
    threadProjectId: "web" as never,
    linearBindings: linearBindings as never,
  });

describe("resolveIssueUrl", () => {
  it.each([
    ["https://github.com/acme/web/issues/42", "web", "acme/web", 42],
    ["https://gitlab.example.com/team/api/-/issues/7", "api", "team/api", 7],
    ["https://gitlab.example.com/team/api/-/work_items/7", "api", "team/api", 7],
    ["https://dev.azure.com/org/project/_workitems/edit/12", "ado", "org/project/repo", 12],
  ])("reads %s through the project that owns it", (url, projectId, repository, number) => {
    expect(resolve(url)).toEqual({ issue: { projectId, repository, number } });
  });

  it("refuses an issue no project here can read", () => {
    expect(resolve("https://github.com/other/repo/issues/3")).toMatchObject({
      error: expect.stringContaining("github.com/other/repo"),
    });
  });

  it("ignores pull requests and plain pages", () => {
    expect(resolve("https://github.com/acme/web/pull/42")).toBeNull();
    expect(resolve("https://example.com/docs")).toBeNull();
  });

  it("reads Linear through the bound project, then the thread's project", () => {
    expect(
      resolve("https://linear.app/acme/issue/ENG-5/title", { api: { repository: "eng" } }),
    ).toMatchObject({ issue: { projectId: "api", provider: "linear", repository: "ENG" } });
    expect(resolve("https://linear.app/acme/issue/ENG-5")).toMatchObject({
      issue: { projectId: "web" },
    });
  });
});

describe("resolveIssueUrl with two Linear accounts on one team", () => {
  const url = "https://linear.app/workspace-b/issue/ENG-5/title";
  const a = project("a", "github.com/acme/a", "github", "acme/a");
  const b = project("b", "github.com/acme/b", "github", "acme/b");
  const c = project("c", "github.com/acme/c", "github", "acme/c");
  const bindings = {
    a: { repository: "ENG" },
    b: { repository: "eng" },
    c: { repository: "OPS" },
  } as never;
  const projectFor = (order: ReadonlyArray<EnvironmentProject>, threadProjectId: string) =>
    resolveIssueUrl({
      url,
      projects: order,
      threadProjectId: threadProjectId as never,
      linearBindings: bindings,
    });

  it.each([
    ["b", "b", [a, b, c]],
    ["b", "b", [b, a, c]],
    ["a", "a", [a, b, c]],
    ["a", "a", [b, a, c]],
    ["c", "a", [a, b, c]],
    ["c", "b", [b, a, c]],
    ["web", "a", [a, b, c]],
  ])("reads from thread project %s through %s", (threadProjectId, expected, order) => {
    expect(projectFor(order, threadProjectId)).toMatchObject({ issue: { projectId: expected } });
  });
});

describe("findThreadIssueLink", () => {
  const gitlab = {
    provider: "gitlab",
    repository: "team/api",
    number: 7,
    url: "https://gitlab.example.com/team/api/-/issues/7",
    title: "Issue",
  } as const;
  const linear = {
    provider: "linear",
    repository: "ENG",
    number: 5,
    url: "https://linear.app/acme/issue/ENG-5/title",
    title: "Issue",
  } as const;
  const links = [gitlab, linear];
  const ref = (repository: string, number: number) =>
    ({ projectId: "p", repository, number }) as never;

  it("finds the stored link from another spelling of its URL", () => {
    expect(
      findThreadIssueLink(
        links,
        "https://gitlab.example.com/team/api/-/issues/7/#note_1",
        ref("Team/API", 7),
      ),
    ).toBe(gitlab);
    expect(
      findThreadIssueLink(
        links,
        "https://gitlab.example.com/team/api/-/work_items/7",
        ref("team/api", 7),
      ),
    ).toBe(gitlab);
    expect(findThreadIssueLink(links, "https://linear.app/acme/issue/ENG-5?x=1", null)).toBe(
      linear,
    );
  });

  it("does not match another repository, host, or Linear workspace", () => {
    expect(
      findThreadIssueLink(
        links,
        "https://gitlab.example.com/team/web/-/issues/7",
        ref("team/web", 7),
      ),
    ).toBeNull();
    expect(
      findThreadIssueLink(links, "https://gitlab.com/team/api/-/issues/7", ref("team/api", 7)),
    ).toBeNull();
    expect(
      findThreadIssueLink(links, "https://linear.app/other/issue/ENG-5", ref("ENG", 5)),
    ).toBeNull();
  });

  it("keeps ports and providers separate when matching an alias", () => {
    const stored = { ...gitlab, url: "https://gitlab.example.com:3000/team/api/-/issues/7" };
    expect(
      findThreadIssueLink(
        [stored],
        "https://gitlab.example.com:4000/team/api/-/work_items/7",
        ref("team/api", 7),
      ),
    ).toBeNull();
    expect(
      findThreadIssueLink([gitlab], "https://gitlab.example.com/team/api/-/work_items/7", {
        projectId: ProjectId.make("api"),
        provider: "forgejo",
        repository: "team/api",
        number: 7,
      }),
    ).toBeNull();
  });
});

describe("useIssueLinking operations", () => {
  const environmentId = EnvironmentId.make("env");
  const threadRef = { environmentId, threadId: ThreadId.make("thread") };
  const issue = {
    projectId: ProjectId.make("api"),
    provider: "gitlab",
    repository: "team/api",
    number: 7,
    url: "https://gitlab.example.com/team/api/-/issues/7",
    title: "Issue title",
  } as const;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.configs.mockReturnValue(
      new Map([
        [
          environmentId,
          {
            environment: { capabilities: { issues: true } },
            settings: { issueTracking: { connections: {} } },
          },
        ],
      ]),
    );
    mocks.projects.mockReturnValue(projects);
    mocks.thread.mockReturnValue({ projectId: ProjectId.make("web"), issues: [] });
    mocks.detail.mockResolvedValue(AsyncResult.success(issue));
    mocks.update.mockResolvedValue(AsyncResult.success(undefined));
  });

  it.each(["unsupported", "other environment"])("refuses operations for %s", async (reason) => {
    mocks.thread.mockReturnValue({ projectId: ProjectId.make("web"), issues: [issue] });
    if (reason === "unsupported") mocks.configs.mockReturnValue(new Map());
    const target =
      reason === "unsupported"
        ? threadRef
        : { ...threadRef, environmentId: EnvironmentId.make("other") };
    const linking = useIssueLinking(environmentId);
    expect(linking.canLink(target, issue.url)).toBe(false);
    expect(linking.linkedIssueFor(target, issue.url)).toBeNull();
    for (const linked of [true, false]) {
      await expect(linking.changeLink(target, issue.url, linked)).rejects.toThrow();
    }
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reads in the thread environment and saves the returned source project", async () => {
    mocks.projects.mockReturnValue([
      { ...projects[1], id: "wrong-source", environmentId: "other" },
      ...projects,
    ]);
    await useIssueLinking(environmentId).changeLink(threadRef, issue.url, true);
    expect(mocks.detail).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { projectId: "api", repository: "team/api", number: 7 },
    });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: threadRef.threadId, issueLink: issue },
    });
  });

  it.each([
    ["a", "b"],
    ["b", "a"],
  ])(
    "reads Linear through the thread project when %s and %s share its team",
    async (first, second) => {
      mocks.configs.mockReturnValue(
        new Map([
          [
            environmentId,
            {
              environment: { capabilities: { issues: true } },
              settings: {
                issueTracking: {
                  connections: {
                    linear: {
                      projectBindings: { a: { repository: "ENG" }, b: { repository: "ENG" } },
                    },
                  },
                },
              },
            },
          ],
        ]),
      );
      mocks.projects.mockReturnValue([
        { ...projects[0], id: "b", environmentId: "other" },
        { ...projects[0], id: first },
        { ...projects[0], id: second },
      ]);
      mocks.thread.mockReturnValue({ projectId: ProjectId.make("b"), issues: [] });
      const url = "https://linear.app/workspace-b/issue/ENG-5/title";
      mocks.detail.mockResolvedValue(
        AsyncResult.success({
          ...issue,
          projectId: "b",
          provider: "linear",
          repository: "ENG",
          number: 5,
          url,
        }),
      );
      await useIssueLinking(environmentId).changeLink(threadRef, url, true);
      expect(mocks.detail).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          projectId: "b",
          provider: "linear",
          host: "linear.app",
          repository: "ENG",
          number: 5,
        },
      });
      expect(mocks.update).toHaveBeenCalledOnce();
    },
  );

  it("unlinks a saved GitLab issue through its work_items alias after its project is gone", async () => {
    mocks.projects.mockReturnValue([]);
    mocks.thread.mockReturnValue({ projectId: ProjectId.make("web"), issues: [issue] });
    const alias = "https://gitlab.example.com/team/api/-/work_items/7";
    const linking = useIssueLinking(environmentId);
    expect(linking.linkedIssueFor(threadRef, alias)).toBe(issue);
    await linking.changeLink(threadRef, alias, false);
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        issueUnlink: {
          provider: issue.provider,
          repository: issue.repository,
          number: issue.number,
          url: issue.url,
        },
      },
    });
  });

  it.each([
    ["linear", "https://linear.app/other/issue/ENG-5/title", "https://linear.app/acme/issue/ENG-5"],
    ["gitlab", "https://gitlab.example.com/team/api/-/merge_requests/7", issue.url],
  ])("rejects a returned %s issue with the wrong URL", async (provider, url, reference) => {
    mocks.detail.mockResolvedValue(AsyncResult.success({ ...issue, provider, url }));
    await expect(
      useIssueLinking(environmentId).changeLink(threadRef, reference, true),
    ).rejects.toThrow(provider === "linear" ? "different Linear workspace" : "pull request");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ["detail", true],
    ["metadata", true],
    ["metadata", false],
  ] as const)("reports %s failures and interruptions when linked=%s", async (stage, linked) => {
    if (!linked)
      mocks.thread.mockReturnValue({ projectId: ProjectId.make("web"), issues: [issue] });
    const operation = stage === "detail" ? mocks.detail : mocks.update;
    const error = new Error("Host request failed");
    for (const cause of [Cause.fail(error), Cause.interrupt()]) {
      operation.mockResolvedValueOnce(AsyncResult.failure(cause));
      await expect(
        useIssueLinking(environmentId).changeLink(threadRef, issue.url, linked),
      ).rejects.toThrow(Cause.hasInterruptsOnly(cause) ? "Link update interrupted" : error.message);
    }
    if (stage === "detail") expect(mocks.update).not.toHaveBeenCalled();
  });
});
