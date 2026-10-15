import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  SourceControlProviderKind,
  type PullRequestListEntry,
  type PullRequestProviderSummary,
  type PullRequestListResult,
} from "@t3tools/contracts";
import {
  appendPullRequestListPage,
  DEFAULT_PR_LIST_CONTROLS,
  filterPullRequestList,
  groupPullRequestListErrors,
  mergePullRequestListEntries,
  mergeEnvironmentPullRequestPages,
  nextPullRequestListInput,
  pullRequestListFacets,
  pullRequestListErrorMessage,
  pullRequestListHead,
  pullRequestListReviewStatus,
  pullRequestLabelColor,
  scopedPullRequestListKey,
  pullRequestListRowsAreEqual,
  withoutScratchProjectScope,
} from "./pullRequestList";

function entry(number: number, patch: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    number,
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "org/repo",
    projectId: "project" as PullRequestListEntry["projectId"],
    projectTitle: "Project",
    title: `Change ${number}`,
    url: `https://github.com/org/repo/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `branch-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: `2026-10-${String(number).padStart(2, "0")}T00:00:00Z`,
    observedAt: 1,
    viewerReviewRequested: false,
    labels: [],
    ...patch,
  };
}
function page(
  entries: readonly PullRequestListEntry[],
  nextCursors: PullRequestListResult["nextCursors"] = {},
): PullRequestListResult {
  return {
    entries,
    nextCursors,
    truncated: Object.keys(nextCursors).length > 0,
    viewers: { "github.com": "octocat" },
    providers: [],
    errors: [],
  };
}

function provider(patch: Partial<PullRequestProviderSummary> = {}): PullRequestProviderSummary {
  return {
    host: "github.com",
    kind: SourceControlProviderKind.make("github"),
    searchesOnHost: true,
    actions: [],
    projectCount: 1,
    configured: true,
    detail: null,
    ...patch,
  };
}

describe("recycled PR list rows", () => {
  const scopedEntry = (patch: Partial<PullRequestListEntry> = {}) => ({
    ...entry(1, patch),
    environmentId: EnvironmentId.make("env-one"),
  });

  it("keeps an unchanged row through provider refreshes and newly allocated labels and authors", () => {
    const labels = [{ name: "bug", color: "ff0000" }];
    expect(
      pullRequestListRowsAreEqual(
        scopedEntry({ labels }),
        scopedEntry({ labels: labels.map((label) => ({ ...label })), observedAt: 20 }),
      ),
    ).toBe(true);
  });

  it.each([
    { title: "New title" },
    { additions: 8 },
    { deletions: 4 },
    { checksState: "failing" as const },
    { reviewDecision: "approved" as const },
    { viewerReviewRequested: true },
    { isDraft: true },
    { state: "closed" as const },
    { author: { login: "another", name: null, avatarUrl: null } },
    { author: { login: "octocat", name: null, avatarUrl: "https://example.com/avatar.png" } },
    { labels: [{ name: "bug", color: "ff0000" }] },
    { stack: { number: 1, position: 2, size: 3, base: "main" } },
  ])("updates the row when visible status or quick actions change: %j", (patch) => {
    expect(pullRequestListRowsAreEqual(scopedEntry(), scopedEntry(patch))).toBe(false);
  });

  it("updates navigation and commands when a duplicate moves to another environment", () => {
    const original = scopedEntry();
    expect(
      pullRequestListRowsAreEqual(original, {
        ...original,
        environmentId: EnvironmentId.make("env-two"),
      }),
    ).toBe(false);
  });
});

describe("mobile PR list pagination", () => {
  it("continues only the repositories that have more, preserving the query and filters", () => {
    const first = pullRequestListHead(
      null,
      page([entry(3)], { "github.com org/repo": "opaque-boundary" }),
    );
    expect(
      nextPullRequestListInput(first, {
        state: "open",
        query: "fix",
        filters: { draft: "hide" },
        limit: 30,
      }),
    ).toEqual({
      state: "open",
      query: "fix",
      filters: { draft: "hide" },
      limit: 30,
      cursors: { "github.com org/repo": "opaque-boundary" },
    });
    const next = appendPullRequestListPage(first, page([entry(2), entry(1)]), {
      state: "open",
      cursors: first.nextCursors,
    });
    expect(next.entries.map((row) => row.number)).toEqual([3, 2, 1]);
    expect(nextPullRequestListInput(next, { state: "open" })).toBeNull();
  });
  it("deduplicates page boundaries and never overwrites a fresh row with an older slice", () => {
    const current = entry(2, { title: "Retitled", observedAt: 20 });
    expect(
      mergePullRequestListEntries([current], [entry(2, { observedAt: 10 }), entry(1)]),
    ).toEqual([current, entry(1)]);
    expect(
      mergePullRequestListEntries([entry(1)], [entry(2, { host: "enterprise.test" }), entry(2)]),
    ).toHaveLength(3);
  });
  it("refreshes the head without dropping older loaded pages or rewinding their cursor", () => {
    const first = pullRequestListHead(null, page([entry(3)], { repo: "first" }));
    const continued = appendPullRequestListPage(first, page([entry(2)], { repo: "second" }), {
      state: "open",
      cursors: first.nextCursors,
    });
    const updated = pullRequestListHead(
      continued,
      page([entry(4), entry(3, { title: "New title", observedAt: 2 })], { repo: "first-new" }),
    );
    expect(updated.entries.map((row) => row.number)).toEqual([4, 3, 2]);
    expect(updated.entries[1]?.title).toBe("New title");
    expect(updated.nextCursors).toEqual({ repo: "second" });
    expect(pullRequestListHead(updated, updated.head)).toBe(updated);
  });
  it("can grow legacy listings that provide no cursor, without exceeding the wire limit", () => {
    const first = pullRequestListHead(null, { ...page([entry(1)]), truncated: true });
    expect(nextPullRequestListInput(first, { state: "all" })?.limit).toBe(60);
    expect(nextPullRequestListInput({ ...first, limit: 490 }, { state: "all" })?.limit).toBe(500);
    expect(nextPullRequestListInput({ ...first, limit: 500 }, { state: "all" })).toBeNull();
  });
  it("advances readable repositories while retaining failed repository cursors", () => {
    const first = pullRequestListHead(
      null,
      page([entry(3)], { readable: "readable-first", failed: "failed-first" }),
    );
    const partial = appendPullRequestListPage(
      first,
      {
        ...page([entry(2)], { readable: "readable-second" }),
        errors: [
          {
            projectId: entry(1).projectId,
            projectTitle: "Failed",
            message: "Failed could not be read.",
            cursorKey: "failed",
          },
        ],
      },
      { state: "open", cursors: first.nextCursors },
    );
    expect(partial.nextCursors).toEqual({
      readable: "readable-second",
      failed: "failed-first",
    });
  });
  it("keeps the whole continuation when an older server omits failed cursor keys", () => {
    const first = pullRequestListHead(null, page([entry(2)], { repo: "first" }));
    const partial = appendPullRequestListPage(
      first,
      {
        ...page([entry(1)], { repo: "second" }),
        errors: [
          {
            projectId: entry(1).projectId,
            projectTitle: "Project",
            message: "Project could not be read.",
          },
        ],
      },
      { state: "open", cursors: first.nextCursors },
    );
    expect(partial.entries.map((row) => row.number)).toEqual([2, 1]);
    expect(partial.nextCursors).toEqual({ repo: "first" });
  });
  it("keeps a limit-based continuation retryable after a keyed repository failure", () => {
    const first = pullRequestListHead(null, { ...page([entry(3)]), truncated: true });
    const input = nextPullRequestListInput(first, { state: "open" })!;
    const partial = appendPullRequestListPage(
      first,
      {
        ...page([entry(2)]),
        errors: [
          {
            projectId: entry(1).projectId,
            projectTitle: "Failed",
            message: "HTTP 404",
            host: "github.com",
            cursorKey: "github.com org/failed",
          },
        ],
      },
      input,
    );

    expect(partial.entries.map((row) => row.number)).toEqual([3, 2]);
    expect(nextPullRequestListInput(partial, { state: "open" })).toEqual(input);
    const retried = appendPullRequestListPage(partial, page([entry(1)]), input);
    expect(retried.entries.map((row) => row.number)).toEqual([3, 2, 1]);
    expect(nextPullRequestListInput(retried, { state: "open" })).toBeNull();
  });
});

describe("all-environment PR list", () => {
  const cups = EnvironmentId.make("cups");
  const mbp = EnvironmentId.make("mbp");
  it("combines independent pages, collapses duplicate PRs, and keeps their source for navigation", () => {
    const first = pullRequestListHead(null, page([entry(3), entry(1)], { repo: "cups-next" }));
    const second = pullRequestListHead(null, page([entry(2), entry(1)], { repo: "mbp-next" }));
    const merged = mergeEnvironmentPullRequestPages([
      { environmentId: cups, pages: first },
      { environmentId: mbp, pages: second },
    ]);
    const rows = filterPullRequestList(
      merged.entries,
      DEFAULT_PR_LIST_CONTROLS,
      merged.viewers,
      "",
      merged.localSearchHosts,
    );
    expect(rows.map((row) => [row.number, row.environmentId])).toEqual([
      [3, cups],
      [2, mbp],
      [1, cups],
    ]);
    expect(scopedPullRequestListKey(rows[1]!)).toBe("mbp:github.com:org/repo:2");
    expect(nextPullRequestListInput(first, { state: "open" })?.cursors).toEqual({
      repo: "cups-next",
    });
    expect(nextPullRequestListInput(second, { state: "open" })?.cursors).toEqual({
      repo: "mbp-next",
    });
    const continued = appendPullRequestListPage(first, page([entry(4)]), {
      state: "open",
      cursors: first.nextCursors,
    });
    expect(nextPullRequestListInput(continued, { state: "open" })).toBeNull();
    expect(nextPullRequestListInput(second, { state: "open" })?.cursors).toEqual({
      repo: "mbp-next",
    });
  });
  it("uses the viewer account and search support from each environment before deduplicating", () => {
    const remote = {
      ...page([entry(1, { author: { login: "other", name: null, avatarUrl: null } })]),
      viewers: { "github.com": "other" },
    };
    const local = page([entry(1), entry(2)]);
    const merged = mergeEnvironmentPullRequestPages([
      { environmentId: cups, pages: pullRequestListHead(null, remote) },
      { environmentId: mbp, pages: pullRequestListHead(null, local) },
    ]);
    const byMe = filterPullRequestList(
      merged.entries,
      { ...DEFAULT_PR_LIST_CONTROLS, involvement: "authored" },
      merged.viewers,
      "",
      merged.localSearchHosts,
    );
    expect(byMe.map((row) => [row.number, row.environmentId])).toEqual([
      [2, mbp],
      [1, cups],
    ]);
    const localOnlySearch = new Set([`${cups} github.com`]);
    const searched = filterPullRequestList(
      merged.entries,
      DEFAULT_PR_LIST_CONTROLS,
      merged.viewers,
      "body match",
      localOnlySearch,
    );
    expect(searched.map((row) => [row.number, row.environmentId])).toEqual([
      [2, mbp],
      [1, mbp],
    ]);
  });
  it("scopes a project to its owning environment even if another has the same project id", () => {
    const merged = mergeEnvironmentPullRequestPages([
      { environmentId: cups, pages: pullRequestListHead(null, page([entry(1)])) },
      { environmentId: mbp, pages: pullRequestListHead(null, page([entry(2)])) },
    ]);
    expect(
      filterPullRequestList(
        merged.entries,
        { ...DEFAULT_PR_LIST_CONTROLS, projectId: "project", projectEnvironmentId: mbp },
        merged.viewers,
        "",
        merged.localSearchHosts,
      ).map((row) => row.environmentId),
    ).toEqual([mbp]);
  });
  it("keeps provider summaries with the environment that reported them", () => {
    const result = { ...page([]), providers: [provider({ host: "github.acme.dev" })] };
    const merged = mergeEnvironmentPullRequestPages([
      { environmentId: cups, pages: pullRequestListHead(null, result) },
    ]);

    expect(merged.providers).toEqual([
      expect.objectContaining({ environmentId: cups, host: "github.acme.dev" }),
    ]);
  });
});

describe("mobile PR scan and filters", () => {
  it("shows review verdicts separately from checks and prioritizes changes requested", () => {
    expect(
      pullRequestListReviewStatus({
        reviewDecision: "changes-requested",
        viewerReviewRequested: true,
      })?.accessibleLabel,
    ).toBe("Changes requested");
    expect(
      pullRequestListReviewStatus({ reviewDecision: "approved", viewerReviewRequested: false })
        ?.label,
    ).toBe("Approved");
    expect(pullRequestListReviewStatus({ viewerReviewRequested: true })?.label).toBe("Your review");
    expect(pullRequestListReviewStatus({ viewerReviewRequested: false })).toBeNull();
  });
  it("resolves authored and author:me per host rather than mixing account identities", () => {
    const rows = [entry(1), entry(2, { host: "enterprise.test" })];
    const viewers = { "github.com": "Octocat", "enterprise.test": "someone-else" };
    expect(
      filterPullRequestList(
        rows,
        { ...DEFAULT_PR_LIST_CONTROLS, involvement: "authored" },
        viewers,
        "",
        new Set(),
      ).map((row) => row.number),
    ).toEqual([1]);
    expect(
      filterPullRequestList(
        rows,
        { ...DEFAULT_PR_LIST_CONTROLS, filters: { author: "me" } },
        viewers,
        "",
        new Set(),
      ).map((row) => row.number),
    ).toEqual([1]);
  });
  it("combines label groups, exclusions, draft and review filters", () => {
    const rows = [
      entry(1, {
        labels: [
          { name: "size:XS", color: null },
          { name: "bug", color: null },
        ],
        reviewDecision: "approved",
      }),
      entry(2, { isDraft: true, labels: [{ name: "bug", color: null }] }),
      entry(3, { labels: [{ name: "feature", color: null }] }),
    ];
    const filters = {
      draft: "hide" as const,
      review: "approved" as const,
      labels: [["SIZE:XS", "size:S"], ["bug"]],
      excludedLabels: ["feature"],
    };
    expect(
      filterPullRequestList(rows, { ...DEFAULT_PR_LIST_CONTROLS, filters }, {}, "", new Set()).map(
        (row) => row.number,
      ),
    ).toEqual([1]);
  });
  it("does not label unsupported review summaries as reviewed or match text locally on host-search results", () => {
    expect(
      filterPullRequestList(
        [entry(1)],
        { ...DEFAULT_PR_LIST_CONTROLS, filters: { review: "approved" } },
        {},
        "body text",
        new Set(),
      ),
    ).toHaveLength(1);
    expect(
      filterPullRequestList(
        [entry(1)],
        DEFAULT_PR_LIST_CONTROLS,
        {},
        "body text",
        new Set(["github.com"]),
      ),
    ).toHaveLength(0);
  });
  it("lists a shared repository's row from a connected environment over an offline one", () => {
    const rows = [
      { ...entry(1), environmentId: "laptop" },
      { ...entry(1), environmentId: "server" },
    ];
    const pick = (connected: ReadonlySet<string>) =>
      filterPullRequestList(rows, DEFAULT_PR_LIST_CONTROLS, {}, "", new Set(), connected).map(
        (row) => row.environmentId,
      );
    expect(pick(new Set(["server"]))).toEqual(["server"]);
    expect(pick(new Set(["laptop", "server"]))).toEqual(["laptop"]);
    expect(pick(new Set())).toEqual(["laptop"]);
  });
  it("sorts loaded rows and builds unique author and label options", () => {
    const rows = [
      entry(1, { labels: [{ name: "bug", color: null }] }),
      entry(2, {
        labels: [
          { name: "bug", color: null },
          { name: "feature", color: null },
        ],
      }),
    ];
    expect(
      filterPullRequestList(
        rows,
        { ...DEFAULT_PR_LIST_CONTROLS, sort: "oldest" },
        {},
        "",
        new Set(),
      ).map((row) => row.number),
    ).toEqual([1, 2]);
    expect(pullRequestListFacets(rows)).toEqual({
      authors: ["octocat"],
      labels: ["bug", "feature"],
    });
    expect(pullRequestLabelColor("ffab00")).toBe("#ffab00");
    expect(pullRequestLabelColor("not-a-color")).toBeNull();
  });
});

describe("pull request list errors", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const repository = (index: number) => ({
    environmentId,
    projectId: `project-${index}`,
    projectTitle: `repo-${index}`,
    message: `org/repo-${index} could not be read.`,
    host: "github.com",
  });

  it("keeps environment failures apart from repeated repository failures", () => {
    const offline = {
      environmentId: EnvironmentId.make("environment-2"),
      projectTitle: "",
      message: "Disconnected.",
    };
    const grouped = groupPullRequestListErrors([
      repository(1),
      offline,
      repository(2),
      repository(1),
    ]);

    expect(grouped.environments).toEqual([offline]);
    expect(grouped.repositories.map((error) => error.projectTitle)).toEqual(["repo-1", "repo-2"]);
  });

  it("shows one actionable host failure instead of its repository errors", () => {
    const failedProvider = {
      ...provider({
        configured: false,
        detail: "Run gh auth login --hostname github.com.",
      }),
      environmentId,
    };
    const grouped = groupPullRequestListErrors(
      [repository(1), repository(2), { ...repository(3), host: "gitlab.com" }],
      [failedProvider],
    );

    expect(grouped.providers).toEqual([failedProvider]);
    expect(grouped.repositories.map((error) => error.projectTitle)).toEqual(["repo-3"]);
    expect(pullRequestListErrorMessage([repository(1), repository(2)], [failedProvider])).toBe(
      "github.com: Run gh auth login --hostname github.com.",
    );
  });

  it("keeps legacy repository errors whose host is absent", () => {
    const legacy = { ...repository(1), host: undefined };
    const failedProvider = {
      ...provider({ detail: "GitHub could not be reached." }),
      environmentId,
    };

    expect(groupPullRequestListErrors([legacy], [failedProvider]).repositories).toEqual([legacy]);
  });

  it("hides stale host and repository details when the environment request fails", () => {
    const offline = { environmentId, projectTitle: "", message: "Disconnected." };
    const failedProvider = {
      ...provider({ detail: "GitHub could not be reached." }),
      environmentId,
    };

    const grouped = groupPullRequestListErrors([repository(1), offline], [failedProvider]);
    expect(grouped.environments).toEqual([offline]);
    expect(grouped.providers).toEqual([]);
    expect(grouped.repositories).toEqual([]);
  });

  it("hides cached errors from disconnected environments", () => {
    const failedProvider = {
      ...provider({ detail: "GitHub could not be reached." }),
      environmentId,
    };

    const grouped = groupPullRequestListErrors(
      [repository(1)],
      [failedProvider],
      new Set([EnvironmentId.make("environment-2")]),
    );
    expect(grouped.environments).toEqual([]);
    expect(grouped.providers).toEqual([]);
    expect(grouped.repositories).toEqual([]);
  });

  it("summarizes many repository failures in one line", () => {
    expect(pullRequestListErrorMessage([repository(1)])).toBe(
      "repo-1: org/repo-1 could not be read.",
    );
    expect(pullRequestListErrorMessage([1, 2, 3].map(repository))).toBe(
      "3 repositories could not be read.",
    );
  });
});

describe("withoutScratchProjectScope", () => {
  const projects = [
    { id: "repo", environmentId: "env-a" },
    { id: "scratch", environmentId: "env-a", isScratch: true as const },
  ];

  it("reads a scope saved on the Scratch folder as all projects", () => {
    const controls = withoutScratchProjectScope(
      { ...DEFAULT_PR_LIST_CONTROLS, projectId: "scratch", projectEnvironmentId: "env-a" },
      projects,
    );
    expect(controls.projectId).toBeUndefined();
    expect(controls.projectEnvironmentId).toBeUndefined();
  });

  it("keeps a repository scope, and one whose projects have not arrived yet", () => {
    const repository = {
      ...DEFAULT_PR_LIST_CONTROLS,
      projectId: "repo",
      projectEnvironmentId: "env-a",
    };
    expect(withoutScratchProjectScope(repository, projects)).toBe(repository);
    const pending = { ...repository, projectId: "scratch" };
    expect(withoutScratchProjectScope(pending, [])).toBe(pending);
  });

  it("keeps another server's project that shares the Scratch folder's id", () => {
    const elsewhere = {
      ...DEFAULT_PR_LIST_CONTROLS,
      projectId: "scratch",
      projectEnvironmentId: "env-b",
    };
    expect(withoutScratchProjectScope(elsewhere, projects)).toBe(elsewhere);
  });
});
