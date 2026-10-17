import type {
  IssueDetail,
  IssueLinkedPullRequest,
  IssueRef,
  SourceControlProviderKind,
  IssueReaction,
  IssueReactionContent,
} from "@t3tools/contracts";
import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  issueAssigneeOptions,
  issueSupportsReactions,
  offeredIssueReactionContents,
  retainUnacknowledgedIssueReactions,
  issueDisplayLabel,
  issueLabelOptions,
  issueLabelId,
  issuePickerIds,
  heldIssuePicker,
  type IssuePickerConfirmed,
  issueStateActionLabel,
  sameIssueState,
  linkedPullRequestTarget,
  nextIssueAssignees,
  isIssueAssignee,
} from "./issueDetail.logic";
import { applyPendingPullRequestReactions } from "../pullRequest/pullRequestReactions.logic";

const actor = (login: string, id: string) => ({ login, name: null, avatarUrl: null, id });

it("keeps native workflow names and distinguishes states with the same name and different IDs", () => {
  const todo = { category: "open" as const, name: "Todo", id: "todo" };
  const review = { category: "open" as const, name: "In Review", id: "review" };
  expect(issueStateActionLabel(review)).toBe("In Review");
  expect(sameIssueState(todo, review)).toBe(false);
  expect(sameIssueState(review, { ...review, id: "other" })).toBe(false);
  expect(issueStateActionLabel({ category: "open", name: "open" })).toBe("Reopen");
  expect(issueStateActionLabel({ category: "closed", name: "closed" })).toBe("Close");
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

describe("nextIssueAssignees", () => {
  it("adds by native id and keeps every existing assignee, seen in candidates or not", () => {
    expect(
      nextIssueAssignees([actor("alice", "11"), actor("ghost", "99")], actor("bob", "22")),
    ).toEqual(["11", "99", "22"]);
  });

  it("falls back to the login where the tracker gives no id", () => {
    expect(
      nextIssueAssignees(
        [{ login: "octocat", name: null, avatarUrl: null }],
        actor("hubot", "hubot"),
      ),
    ).toEqual(["octocat", "hubot"]);
  });

  it("removes the candidate when it is already assigned", () => {
    expect(
      nextIssueAssignees([actor("Ada", "acc-1"), actor("Bo", "acc-2")], actor("Ada", "acc-1")),
    ).toEqual(["acc-2"]);
  });

  it("replaces the assignee on a single-assignee tracker", () => {
    expect(nextIssueAssignees([actor("Ada", "acc-1")], actor("Bo", "acc-2"), 1)).toEqual(["acc-2"]);
  });

  it("keeps opaque actor IDs exact and folds only actors without a native ID", () => {
    const current = [actor("Ada", "JIRAUSER123")];
    const other = actor("Bo", "jirauser123");
    expect(isIssueAssignee(current, other.id)).toBe(false);
    expect(nextIssueAssignees(current, other, 1)).toEqual([other.id]);
    expect(nextIssueAssignees(current, other, 2)).toEqual(["JIRAUSER123", other.id]);
    expect(issueAssigneeOptions(current, [other], "").map((item) => item.id)).toEqual([
      "jirauser123",
      "JIRAUSER123",
    ]);
    const legacy = [{ login: "Octocat", name: null, avatarUrl: null }];
    expect(isIssueAssignee(legacy, "octocat")).toBe(true);
    expect(nextIssueAssignees(legacy, actor("octocat", "octocat"))).toEqual([]);
    expect(issueAssigneeOptions(legacy, [actor("octocat", "octocat")], "")).toHaveLength(1);
  });
});

describe("linkedPullRequestTarget", () => {
  const environmentId = EnvironmentId.make("environment");
  const checkout: EnvironmentProject = {
    environmentId,
    id: ProjectId.make("git-checkout"),
    title: "Git checkout",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    repositoryIdentity: {
      provider: "github",
      canonicalKey: "github.com/acme/web",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/web.git",
      },
    },
  };
  const link: IssueLinkedPullRequest = {
    repository: "acme/web",
    number: 7,
    title: "Fix it",
    url: "https://github.com/acme/web/pull/7",
    state: "open",
    isDraft: false,
    closesIssue: false,
  };
  const ref = (tracker: string, host?: string): IssueRef =>
    ({ projectId: "p", tracker, ...(host ? { host } : {}), scope: "s", key: "1" }) as IssueRef;

  it("routes with the link's own provider and host, never the tracker's", () => {
    expect(
      linkedPullRequestTarget(
        { ...link, provider: "github" as SourceControlProviderKind, host: "github.com" },
        ref("linear", "linear.app"),
        environmentId,
        [checkout],
      ),
    ).toEqual({
      projectId: "git-checkout",
      host: "github.com",
      repository: "acme/web",
      number: 7,
      url: link.url,
    });
  });

  it("falls back to a git tracker's own kind and host", () => {
    const gitlab = {
      ...checkout,
      repositoryIdentity: {
        ...checkout.repositoryIdentity!,
        provider: "gitlab",
        canonicalKey: "gitlab.example.com/acme/web",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://gitlab.example.com/acme/web.git",
        },
      },
    };
    expect(
      linkedPullRequestTarget(
        { ...link, url: "https://gitlab.example.com/acme/web/-/merge_requests/7" },
        ref("gitlab", "gitlab.example.com"),
        environmentId,
        [gitlab],
      ),
    ).toMatchObject({
      projectId: "git-checkout",
      host: "gitlab.example.com",
    });
  });

  it("does not guess for a standalone tracker without a provider", () => {
    expect(
      linkedPullRequestTarget(link, ref("linear", "linear.app"), environmentId, [checkout]),
    ).toBeNull();
  });

  it.each([
    "none",
    "other-environment",
    "other-provider",
    "unsupported-provider",
    "other-host",
    "matched",
    "foreign-repository",
  ])("routes a Linear-linked GitLab MR only through a supported destination (%s)", (kind) => {
    const native = {
      ...link,
      provider: (kind === "unsupported-provider"
        ? "unsupported"
        : "gitlab") as SourceControlProviderKind,
      host: "gitlab.example.com",
      url: "https://gitlab.example.com/acme/web/-/merge_requests/7",
    };
    const host = kind === "other-host" ? "other.gitlab.example.com" : native.host;
    const repository = kind === "foreign-repository" ? "acme/local" : native.repository;
    const project: EnvironmentProject = {
      ...checkout,
      environmentId: kind === "other-environment" ? EnvironmentId.make("elsewhere") : environmentId,
      repositoryIdentity: {
        provider:
          kind === "other-provider"
            ? "github"
            : kind === "unsupported-provider"
              ? "unsupported"
              : "gitlab",
        canonicalKey: `${host}/${repository}`,
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: `https://${host}/${repository}.git`,
        },
      },
    };
    const target = linkedPullRequestTarget(
      native,
      ref("linear", "linear.app"),
      environmentId,
      kind === "none" ? [] : [project],
    );
    expect(target).toEqual(
      kind === "matched" || kind === "foreign-repository"
        ? {
            projectId: checkout.id,
            host: native.host,
            repository: native.repository,
            number: native.number,
            url: native.url,
          }
        : null,
    );
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
      [actor("ada-renamed", "acc-1"), actor("Bo", "acc-2")],
      "",
    );
    expect(options.map((option) => option.id)).toEqual(["acc-1", "acc-2", "octocat"]);
    expect(nextIssueAssignees([actor("Ada", "acc-1")], options[0]!)).toEqual([]);
  });

  it("searches current assignees by native id", () => {
    expect(
      issueAssigneeOptions([actor("Ada", "acc-9")], [actor("Bo", "acc-2")], "acc-9").map(
        (option) => option.login,
      ),
    ).toEqual(["Ada"]);
  });
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
    comments: [],
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

it("keeps labels with the same name distinct by native ID", () => {
  const team = { id: "team-label", name: "Bug", color: null };
  const workspace = { id: "workspace-label", name: "Bug", color: null, description: null };
  expect(issueLabelOptions([team], [workspace], "bug").map(issueLabelId)).toEqual([
    "workspace-label",
    "team-label",
  ]);
  expect(issueLabelId({ name: "Bug" })).toBe("Bug");
});

it("keeps template selections available before their candidate pages are loaded", () => {
  const label = { name: "Template label", color: null };
  const assignee = actor("Template person", "native-user");
  expect(issueLabelOptions([label], [], "").map(issueLabelId)).toEqual(["Template label"]);
  expect(issueAssigneeOptions([assignee], [], "").map((candidate) => candidate.id)).toEqual([
    "native-user",
  ]);
  expect(issueLabelOptions([], [], "")).toEqual([]);
  expect(issueAssigneeOptions([], [], "")).toEqual([]);
});

it.each(["labels", "assignees"] as const)(
  "holds the confirmed %s whole set until exact native ACK",
  (kind) => {
    const base = detail({
      labels: [{ id: "W", name: "Bug", color: null }],
      assignees: [actor("one", "W")],
    });
    const confirmed: IssuePickerConfirmed = {
      base,
      environmentId: "environment",
      kind,
      ids: ["W", "Other", "T"],
    };
    expect(issuePickerIds({ ...base }, kind, confirmed, "environment")).toEqual([
      "W",
      "Other",
      "T",
    ]);
    const partial = {
      ...base,
      labels: [...base.labels, { id: "Other", name: "Other", color: null }],
      assignees: [...base.assignees, actor("other", "Other")],
    };
    expect(heldIssuePicker(partial, kind, confirmed, "environment")).toBe(confirmed);
    const acknowledged = {
      ...partial,
      labels: [{ id: "T", name: "Bug", color: null }, ...partial.labels],
      assignees: [actor("team", "T"), ...partial.assignees],
    };
    expect(heldIssuePicker(acknowledged, kind, confirmed, "environment")).toBeNull();
    expect(heldIssuePicker(base, kind, confirmed, "other-environment")).toBeNull();
    expect(heldIssuePicker({ ...base, key: "2" }, kind, confirmed, "environment")).toBeNull();
  },
);

it("retains a case-sensitive assignee selection until the exact native ID acknowledges it", () => {
  const base = detail({ assignees: [actor("Ada", "JIRAUSER123")] });
  const confirmed: IssuePickerConfirmed = {
    base,
    environmentId: "environment",
    kind: "assignees",
    ids: ["jirauser123"],
  };
  expect(heldIssuePicker({ ...base }, "assignees", confirmed, "environment")).toBe(confirmed);
  expect(
    heldIssuePicker(
      { ...base, assignees: [actor("Bo", "jirauser123")] },
      "assignees",
      confirmed,
      "environment",
    ),
  ).toBeNull();
  const legacy = { ...base, assignees: [{ login: "Octocat", name: null, avatarUrl: null }] };
  expect(
    heldIssuePicker(legacy, "assignees", { ...confirmed, ids: ["octocat"] }, "environment"),
  ).toBeNull();
});
