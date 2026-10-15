import type {
  IssueComment,
  IssueDetail,
  IssueReaction,
  IssueReactionContent,
  IssueLinkedPullRequest,
  IssueRef,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  appendOlderIssueComments,
  issueAssigneeOptions,
  issueCommentsView,
  issueSupportsReactions,
  offeredIssueReactionContents,
  retainUnacknowledgedIssueReactions,
  issueDisplayLabel,
  issueLabelOptions,
  nextIssueLabels,
  issuePickerIds,
  heldIssuePicker,
  type IssuePickerConfirmed,
  linkedPullRequestTarget,
  nextIssueAssignees,
} from "./issueDetail.logic";

import { applyPendingPullRequestReactions } from "../pullRequest/pullRequestReactions.logic";

const actor = (login: string, id: string) => ({ login, name: null, avatarUrl: null, id });

describe("nextIssueAssignees", () => {
  it("adds by native id and keeps every existing assignee, seen in candidates or not", () => {
    expect(nextIssueAssignees(["11", "99"], "22")).toEqual(["11", "99", "22"]);
  });

  it("falls back to the login where the tracker gives no id", () => {
    expect(
      nextIssueAssignees(
        issuePickerIds(
          detail({ assignees: [{ login: "octocat", name: null, avatarUrl: null }] }),
          "assignees",
          null,
          "environment",
        ),
        "hubot",
      ),
    ).toEqual(["octocat", "hubot"]);
  });

  it("removes the candidate when it is already assigned", () => {
    expect(nextIssueAssignees(["acc-1", "acc-2"], "acc-1")).toEqual(["acc-2"]);
  });

  it("replaces the assignee on a single-assignee tracker", () => {
    expect(nextIssueAssignees(["acc-1"], "acc-2", 1)).toEqual(["acc-2"]);
  });
});

describe("linkedPullRequestTarget", () => {
  const environmentId = EnvironmentId.make("environment");
  const lending = { pullRequests: true, threadPullRequests: true };
  const checkout = (provider: string, host: string, repository: string): EnvironmentProject => ({
    environmentId,
    id: ProjectId.make(`${provider}-checkout`),
    title: "Checkout",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    repositoryIdentity: {
      provider,
      canonicalKey: `${host}/${repository}`,
      displayName: repository,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://${host}/${repository}.git`,
      },
    },
  });
  const github = checkout("github", "github.com", "acme/web");
  const gitlab = checkout("gitlab", "gitlab.example.com", "acme/web");
  const link: IssueLinkedPullRequest = {
    repository: "acme/web",
    number: 7,
    title: "Fix it",
    url: "https://github.com/acme/web/pull/7",
    state: "open",
    isDraft: false,
    closesIssue: false,
  };
  const mergeRequest = {
    ...link,
    provider: "gitlab" as SourceControlProviderKind,
    host: "gitlab.example.com",
    url: "https://gitlab.example.com/acme/web/-/merge_requests/7",
  };
  const ref = (tracker: string, host?: string): IssueRef =>
    ({ projectId: "p", tracker, ...(host ? { host } : {}), scope: "s", key: "1" }) as IssueRef;
  const linear = ref("linear", "linear.app");

  it("routes with the link's own provider and host, never the tracker's", () => {
    expect(
      linkedPullRequestTarget(
        { ...link, provider: "github" as SourceControlProviderKind, host: "github.com" },
        linear,
        environmentId,
        [github],
        lending,
      ),
    ).toEqual({
      projectId: github.id,
      host: "github.com",
      repository: "acme/web",
      number: 7,
      url: link.url,
    });
  });

  it("falls back to a git tracker's own kind and host", () => {
    expect(
      linkedPullRequestTarget(
        { ...link, url: mergeRequest.url },
        ref("gitlab", "gitlab.example.com"),
        environmentId,
        [gitlab],
        lending,
      ),
    ).toMatchObject({ projectId: gitlab.id, host: "gitlab.example.com" });
  });

  it("does not guess for a standalone tracker without a provider", () => {
    expect(linkedPullRequestTarget(link, linear, environmentId, [github], lending)).toBeNull();
  });

  it("opens a Linear-linked GitLab merge request on the GitLab checkout, not the Linear project", () => {
    expect(
      linkedPullRequestTarget(mergeRequest, linear, environmentId, [github, gitlab], lending),
    ).toEqual({
      projectId: gitlab.id,
      host: "gitlab.example.com",
      repository: "acme/web",
      number: 7,
      url: mergeRequest.url,
    });
  });

  it.each([
    ["no checkout", [github], lending],
    [
      "a checkout on another environment",
      [{ ...gitlab, environmentId: EnvironmentId.make("elsewhere") }],
      lending,
    ],
    ["a checkout on another host", [checkout("gitlab", "other.example.com", "acme/web")], lending],
    ["a server without pull requests", [gitlab], { pullRequests: false, threadPullRequests: true }],
    ["an old server", [gitlab], undefined],
    [
      "an exact-only server and another repository",
      [checkout("gitlab", "gitlab.example.com", "acme/local")],
      { pullRequests: true },
    ],
  ])("keeps the link external with %s", (_, projects, capabilities) => {
    expect(
      linkedPullRequestTarget(mergeRequest, linear, environmentId, projects, capabilities),
    ).toBeNull();
  });

  it("lends another checkout on the host only where the server reads any repository there", () => {
    const local = checkout("gitlab", "gitlab.example.com", "acme/local");
    expect(
      linkedPullRequestTarget(mergeRequest, linear, environmentId, [local], lending),
    ).toMatchObject({ projectId: local.id, repository: "acme/web" });
  });

  it("names an exact-only server's checkout by its own repository and leaves the host out", () => {
    expect(
      linkedPullRequestTarget(mergeRequest, linear, environmentId, [gitlab], {
        pullRequests: true,
      }),
    ).toEqual({ projectId: gitlab.id, repository: "acme/web", number: 7, url: mergeRequest.url });
  });

  it("keeps a malformed native URL external", () => {
    expect(
      linkedPullRequestTarget(
        { ...mergeRequest, url: "https://gitlab.example.com/acme/web" },
        linear,
        environmentId,
        [gitlab],
        lending,
      ),
    ).toBeNull();
  });
});

describe("issueDisplayLabel", () => {
  it("names the repository beside a bare number and leaves a native key alone", () => {
    expect(issueDisplayLabel("demo/atlas", "#42")).toBe("demo/atlas#42");
    expect(issueDisplayLabel("acme/web", "#123")).toBe("acme/web#123");
    expect(issueDisplayLabel("acme/web", "123")).toBe("acme/web#123");
    expect(issueDisplayLabel("ENG", "ENG-123")).toBe("ENG-123");
  });
});

describe("issueLabelOptions", () => {
  const fetched = [{ name: "bug", color: null, description: "Broken" }];

  it("offers applied labels the catalog did not return, once", () => {
    expect(
      issueLabelOptions(
        [
          { name: "bug", color: "f00" },
          { name: "legacy", color: null },
        ],
        fetched,
        "",
      ).map((label) => label.name),
    ).toEqual(["bug", "legacy"]);
  });

  it("finds an applied label beyond the catalog by search", () => {
    expect(issueLabelOptions([{ name: "legacy", color: null }], fetched, "LEG")).toEqual([
      { name: "legacy", color: null, description: null },
    ]);
  });
});

describe("issueAssigneeOptions", () => {
  it("offers current assignees beyond the catalog so they can be removed", () => {
    const options = issueAssigneeOptions(
      [actor("Ada", "acc-1"), { login: "octocat", name: null, avatarUrl: null }],
      [actor("ada-renamed", "ACC-1"), actor("Bo", "acc-2")],
      "",
    );
    expect(options.map((option) => option.id)).toEqual(["ACC-1", "acc-2", "octocat"]);
    expect(nextIssueAssignees(["acc-1"], options[0]!.id)).toEqual([]);
  });

  it("searches current assignees by native id", () => {
    expect(
      issueAssigneeOptions([actor("Ada", "acc-9")], [actor("Bo", "acc-2")], "acc-9").map(
        (option) => option.login,
      ),
    ).toEqual(["Ada"]);
  });
});

const comment = (id: string, reactions?: IssueComment["reactions"]): IssueComment => ({
  id,
  author: null,
  body: id,
  createdAt: "2026-10-01T00:00:00Z",
  url: null,
  ...(reactions === undefined ? {} : { reactions }),
});

function detail(patch: Partial<IssueDetail> = {}): IssueDetail {
  return {
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
    displayKey: "#1",
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    title: "Issue",
    url: "https://example.com/issue",
    author: null,
    state: { category: "open", name: "Open" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 3,
    writable: true,
    viewer: "viewer",
    body: "",
    comments: [comment("c3")],
    commentsCursor: "page-2",
    events: [],
    linkedPullRequests: [],
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: true,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    ...patch,
  };
}

const heart = [{ content: "heart" as const, count: 1, actors: [], viewerHasReacted: false }];
describe("older issue comments across detail re-reads", () => {
  const first = detail();
  const loaded = appendOlderIssueComments(first, null, {
    comments: [comment("c2", heart)],
    nextCursor: "page-3",
  });

  it("keeps loaded pages when a new detail has the same first-page IDs and cursor", () => {
    const refreshed = detail({
      title: "Renamed",
      comments: [{ ...comment("c3", heart), body: "Updated" }],
    });
    const view = issueCommentsView(refreshed, loaded);
    expect(view.held).toBe(loaded);
    expect(view.comments.map((each) => each.id)).toEqual(["c2", "c3"]);
    expect(view.comments[1]).toEqual(refreshed.comments[0]);
    expect(view.cursor).toBe("page-3");
  });

  it("restarts a shifted Jira head with the same offset and eventually includes every boundary comment", () => {
    const comments = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => comment(String(from + index)));
    const before = detail({
      tracker: IssueTrackerKind.make("jira"),
      host: "workspace.atlassian.net",
      scope: "PROJ",
      comments: comments(101, 150),
      commentsCursor: "50",
      commentCount: 150,
    });
    const loaded = appendOlderIssueComments(before, null, {
      comments: comments(51, 100),
      nextCursor: "100",
    });
    const after = { ...before, comments: comments(102, 151), commentCount: 151 };
    const shifted = issueCommentsView(after, loaded);
    expect(shifted.held).toBeNull();
    expect(shifted.cursor).toBe("50");
    expect(shifted.comments).toHaveLength(50);
    const page2 = appendOlderIssueComments(after, shifted.held, {
      comments: comments(52, 101),
      nextCursor: "100",
    });
    const page3 = appendOlderIssueComments(after, page2, {
      comments: comments(2, 51),
      nextCursor: "150",
    });
    const page4 = appendOlderIssueComments(after, page3, {
      comments: comments(1, 1),
      nextCursor: null,
    });
    const complete = issueCommentsView(after, page4);
    expect(complete.comments.map((each) => each.id)).toEqual(
      comments(1, 151).map((each) => each.id),
    );
    expect(complete.cursor).toBeNull();
  });

  it("drops them when the first page now ends elsewhere or the issue is another one", () => {
    const moved = issueCommentsView(detail({ commentsCursor: "page-2b" }), loaded);
    expect(moved.comments.map((each) => each.id)).toEqual(["c3"]);
    expect(moved.cursor).toBe("page-2b");
    const other = issueCommentsView(detail({ key: "2" }), loaded);
    expect(other.comments.map((each) => each.id)).toEqual(["c3"]);
  });

  it("drops another viewer's loaded pages so their reactions are not shown as this viewer's", () => {
    const mine = [{ ...heart[0]!, viewerHasReacted: true }];
    const asA = detail({ viewer: "a" });
    const loadedByA = appendOlderIssueComments(asA, null, {
      comments: [comment("c_old", mine)],
      nextCursor: null,
    });
    expect(issueCommentsView({ ...asA }, loadedByA).held).toBe(loadedByA);
    const asB = issueCommentsView(detail({ viewer: "b" }), loadedByA);
    expect(asB.held).toBeNull();
    expect(asB.comments.map((each) => each.id)).toEqual(["c3"]);
    expect(asB.cursor).toBe("page-2");
    const unknown = detail({ viewer: null });
    const loadedUnknown = appendOlderIssueComments(unknown, null, {
      comments: [comment("c_old", mine)],
      nextCursor: null,
    });
    expect(issueCommentsView({ ...unknown }, loadedUnknown).held).toBe(loadedUnknown);
    expect(issueCommentsView(detail({ viewer: "b" }), loadedUnknown).held).toBeNull();
    const reread = detail({ viewer: null });
    const fresh = issueCommentsView(reread, loadedUnknown);
    expect(fresh.held).toBeNull();
    expect(fresh.comments.map((each) => each.id)).toEqual(["c3"]);
    expect(fresh.cursor).toBe("page-2");
    const reloaded = appendOlderIssueComments(reread, fresh.held, {
      comments: [comment("c_old", heart)],
      nextCursor: null,
    });
    expect(issueCommentsView(reread, reloaded).comments[0]?.reactions).toEqual(heart);
    expect(issueCommentsView(reread, reloaded).cursor).toBeNull();
  });
});

describe("issue reaction capabilities", () => {
  it("allows Azure comment reactions without offering issue reactions", () => {
    const azure = { reactions: false, commentReactions: true };
    expect(issueSupportsReactions(azure, false)).toBe(false);
    expect(issueSupportsReactions(azure, true)).toBe(true);
    expect(offeredIssueReactionContents(["thumbs-up"])).toEqual(["thumbs-up"]);
  });
  it("honors an explicit comment restriction and older tracker capabilities", () => {
    expect(issueSupportsReactions({ reactions: true, commentReactions: false }, true)).toBe(false);
    expect(issueSupportsReactions({ reactions: true }, true)).toBe(true);
    expect(offeredIssueReactionContents([])).toEqual([]);
    expect(offeredIssueReactionContents(undefined)).toHaveLength(8);
  });
});

describe("confirmed issue reactions", () => {
  const native = (count: number, viewerHasReacted: boolean): IssueReaction[] => [
    { content: "thumbs-up", count, actors: [], viewerHasReacted },
  ];
  it("holds the viewer's confirmed choice through stale reads and other users' count changes", () => {
    const desired = new Map<IssueReactionContent, boolean>([["thumbs-up", true]]);
    const latest = native(5, false);
    const retained = retainUnacknowledgedIssueReactions(latest, desired);
    expect(applyPendingPullRequestReactions(latest, retained)).toEqual(native(6, true));
    expect(retainUnacknowledgedIssueReactions(native(6, true), retained).size).toBe(0);
  });
  it("holds a removal until the native viewer flag or absent reaction confirms it", () => {
    const desired = new Map<IssueReactionContent, boolean>([["thumbs-up", false]]);
    expect(
      applyPendingPullRequestReactions(
        native(3, true),
        retainUnacknowledgedIssueReactions(native(3, true), desired),
      ),
    ).toEqual(native(2, false));
    expect(retainUnacknowledgedIssueReactions(native(2, false), desired).size).toBe(0);
    expect(retainUnacknowledgedIssueReactions([], desired).size).toBe(0);
  });
});

it("keeps workspace and team labels with equal names distinct during native writes", () => {
  const workspace = { id: "workspace-W", name: "Bug", color: null };
  const team = { id: "team-T", name: "Bug", color: null, description: null };
  const other = { id: "other", name: "Other", color: null, description: null };
  expect(issueLabelOptions([workspace], [team, other], "").map((label) => label.id)).toEqual([
    "team-T",
    "other",
    "workspace-W",
  ]);
  expect(nextIssueLabels([workspace.id], other.id)).toEqual(["workspace-W", "other"]);
  expect(nextIssueLabels([workspace.id], team.id)).toEqual(["workspace-W", "team-T"]);
  expect(nextIssueLabels([workspace.id, team.id], team.id)).toEqual(["workspace-W"]);
  expect(nextIssueLabels([workspace.id, team.id], workspace.id)).toEqual(["team-T"]);
  expect(nextIssueLabels([workspace.id, other.id], workspace.id)).toEqual(["other"]);
  expect(
    nextIssueLabels(
      issuePickerIds(
        detail({ labels: [{ name: "Bug", color: null }] }),
        "labels",
        null,
        "environment",
      ),
      "Other",
    ),
  ).toEqual(["Bug", "Other"]);
});

describe("whole issue picker sets before native acknowledgement", () => {
  const environmentId = "environment";
  const workspace = { id: "W", name: "Bug", color: null };
  const team = { id: "T", name: "Bug", color: null };
  const other = { id: "Other", name: "Other", color: null };

  it("retains a native label set across a late first response, another pick, and a failed reversal", () => {
    const base = detail({ labels: [workspace] });
    const first: IssuePickerConfirmed = {
      base,
      environmentId,
      kind: "labels",
      ids: nextIssueLabels(issuePickerIds(base, "labels", null, environmentId), "Other"),
    };
    const sent = nextIssueLabels(issuePickerIds(base, "labels", first, environmentId), "T");
    expect(sent).toEqual(["W", "Other", "T"]);
    const late = { ...base, labels: [workspace, other] };
    const second: IssuePickerConfirmed = { base, environmentId, kind: "labels", ids: sent };
    expect(issuePickerIds(late, "labels", second, environmentId)).toEqual(["W", "Other", "T"]);
    expect(nextIssueLabels(issuePickerIds(late, "labels", second, environmentId), "Other")).toEqual(
      ["W", "T"],
    );
    expect(issuePickerIds({ ...late }, "labels", second, environmentId)).toEqual([
      "W",
      "Other",
      "T",
    ]);
    const acknowledged = { ...late, labels: [team, other, workspace] };
    expect(heldIssuePicker(acknowledged, "labels", second, environmentId)).toBeNull();
  });

  it("retains assignees across the same late-read sequence and keeps native case-insensitive removal", () => {
    const base = detail({ assignees: [actor("one", "W")] });
    const first: IssuePickerConfirmed = {
      base,
      environmentId,
      kind: "assignees",
      ids: nextIssueAssignees(issuePickerIds(base, "assignees", null, environmentId), "Other"),
    };
    const sent = nextIssueAssignees(issuePickerIds(base, "assignees", first, environmentId), "T");
    expect(sent).toEqual(["W", "Other", "T"]);
    const late = { ...base, assignees: [actor("one", "W"), actor("other", "Other")] };
    const second: IssuePickerConfirmed = { base, environmentId, kind: "assignees", ids: sent };
    expect(
      nextIssueAssignees(issuePickerIds(late, "assignees", second, environmentId), "OTHER"),
    ).toEqual(["W", "T"]);
    expect(issuePickerIds(late, "assignees", second, environmentId)).toEqual(["W", "Other", "T"]);
    expect(
      heldIssuePicker(
        { ...late, assignees: [actor("team", "t"), ...late.assignees] },
        "assignees",
        second,
        environmentId,
      ),
    ).toBeNull();
  });

  it.each([
    { tracker: IssueTrackerKind.make("jira") },
    { host: "another.test" },
    { projectId: ProjectId.make("another") },
    { scope: "other/repo" },
    { key: "other" },
  ])("ignores an old write completion on another issue context %j", (patch) => {
    const base = detail({ labels: [workspace] });
    const completed: IssuePickerConfirmed = {
      base,
      environmentId,
      kind: "labels",
      ids: ["W", "Other"],
    };
    expect(issuePickerIds({ ...base, ...patch }, "labels", completed, environmentId)).toEqual([
      "W",
    ]);
    expect(heldIssuePicker(base, "labels", completed, "another-environment")).toBeNull();
    expect(heldIssuePicker(base, "assignees", completed, environmentId)).toBeNull();
  });

  it.each([
    ["a", "b"],
    ["a", null],
    [null, "b"],
  ])("drops a set confirmed as %s once the issue reads as %s", (before, after) => {
    const base = detail({ labels: [workspace], viewer: before });
    const completed: IssuePickerConfirmed = {
      base,
      environmentId,
      kind: "labels",
      ids: ["W", "Other"],
    };
    expect(
      heldIssuePicker(before === null ? base : { ...base }, "labels", completed, environmentId),
    ).toBe(completed);
    expect(
      heldIssuePicker({ ...base, viewer: after }, "labels", completed, environmentId),
    ).toBeNull();
  });
});
