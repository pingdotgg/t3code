import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIssueWriteJson,
  decodeAssigneeCandidatesJson,
  decodeCreatedIssueJson,
  decodeIssueActivityJson,
  decodeIssueCommentsJson,
  decodeIssueDetailJson,
  decodeIssueFormYaml,
  decodeIssueListJson,
  decodeIssueSearchJson,
  decodeIssueSupplementJson,
  decodeIssueTemplateConfigYaml,
  decodeIssueTemplateFormsJson,
  decodeIssueTemplatesJson,
  decodeIssueViewerPermissionsJson,
  decodeRepositoryLabelsJson,
  DEFAULT_ISSUE_TEMPLATE_CONFIG,
  encodeGraphQlRequestJson,
  issueSearchGraphQlQuery,
  ISSUE_DETAIL_JSON_FIELDS,
  ISSUE_LIST_JSON_FIELDS,
  ISSUE_SEARCH_MAX_ROWS,
} from "./gitHubIssueJson.ts";

/** One row as `gh issue list --json` spells it, which is the shape `gh issue view` answers in. */
function issueJson(entry: Record<string, unknown>): string {
  return JSON.stringify({
    number: 1,
    title: "The page never loads",
    url: "https://github.com/acme/web/issues/1",
    state: "OPEN",
    stateReason: "",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    closedAt: null,
    ...entry,
  });
}

function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
  return `[${entries.map((entry) => issueJson(entry)).join(",")}]`;
}

/** One row as the cross-repository search answers it: the listing's row one connection deeper. */
function searchItem(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 7,
    title: "The page never loads",
    url: "https://github.com/acme/web/issues/7",
    author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    repository: { nameWithOwner: "acme/web" },
    ...entry,
  };
}

function searchJson(
  nodes: ReadonlyArray<unknown>,
  hasNextPage = false,
  endCursor?: string,
): string {
  return JSON.stringify({
    data: {
      search: {
        pageInfo: { hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) },
        nodes,
      },
    },
  });
}

/** A change request as a reference to it names it, wherever GitHub found the reference. */
function pullRequestRef(
  number: number,
  entry: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    __typename: "PullRequest",
    number,
    title: `Fix the page (${number})`,
    url: `https://github.com/acme/web/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    repository: { nameWithOwner: "acme/web" },
    ...entry,
  };
}

function supplementJson(input: {
  readonly viewerPermission?: string | null;
  readonly issue?: Record<string, unknown> | null;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        viewerPermission: input.viewerPermission ?? "READ",
        issue: input.issue === undefined ? {} : input.issue,
      },
    },
  });
}

function activityJson(input: {
  readonly author?: Record<string, unknown> | null;
  readonly comments?: Record<string, unknown> | null;
  readonly timeline?: ReadonlyArray<unknown>;
  readonly viewer?: string;
  readonly reactions?: ReadonlyArray<unknown>;
}): string {
  return JSON.stringify({
    data: {
      viewer: input.viewer === undefined ? null : { login: input.viewer },
      repository: {
        issue: {
          author: input.author ?? null,
          reactionGroups: input.reactions ?? [],
          comments: input.comments ?? { totalCount: 0, nodes: [] },
          timelineItems: { nodes: input.timeline ?? [] },
        },
      },
    },
  });
}

function timelineEvent(typename: string, entry: Record<string, unknown> = {}): unknown {
  return {
    __typename: typename,
    id: `${typename}-1`,
    createdAt: "2026-07-03T00:00:00Z",
    actor: { login: "julius", avatarUrl: "https://avatars/julius" },
    ...entry,
  };
}

/** One form as GitHub's GraphQL reports it, name and all. */
function templateEntry(entry: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: "bug_report.md",
    name: "Bug report",
    about: "File a bug",
    title: "Bug: ",
    body: "### Steps",
    assignees: { nodes: [{ login: "julius" }] },
    labels: { nodes: [{ name: "bug" }] },
    ...entry,
  };
}

function issueTemplatesJson(issueTemplates: unknown): string {
  return JSON.stringify({ data: { repository: { issueTemplates } } });
}

/** One `.github/ISSUE_TEMPLATE/` tree read, with a file's text where the entry is a file at all. */
function issueTemplateFormsJson(input: {
  readonly url?: string | null;
  readonly entries?: ReadonlyArray<unknown> | null;
  readonly rootGuidelines?: unknown;
  readonly dotGitHubGuidelines?: unknown;
  readonly docsGuidelines?: unknown;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        url: input.url === undefined ? "https://github.com/acme/web" : input.url,
        forms: input.entries === null ? null : { entries: input.entries ?? [] },
        rootGuidelines: input.rootGuidelines ?? null,
        dotGitHubGuidelines: input.dotGitHubGuidelines ?? null,
        docsGuidelines: input.docsGuidelines ?? null,
      },
    },
  });
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("issue list decoding", () => {
  it("reads an issue with its people, labels and milestone", () => {
    const batch = expectSuccess(
      decodeIssueListJson(
        listJson([
          {
            number: 42,
            author: { login: "bilal", name: "Bilal" },
            assignees: [{ login: "julius", name: "Julius" }, { login: "  " }],
            labels: [{ name: "bug", color: "d73a4a" }, { name: "   " }],
            milestone: { title: "v2" },
          },
        ]),
      ),
    );

    expect(batch.items[0]).toMatchObject({
      number: 42,
      state: "open",
      stateReason: null,
      // No `gh` JSON field carries an avatar, so a listing row has initials to show and no face.
      author: { login: "bilal", name: "Bilal", avatarUrl: null },
      // A person and a label GitHub named nothing for are left out rather than shown blank.
      assignees: [{ login: "julius", name: "Julius", avatarUrl: null }],
      labels: [{ name: "bug", color: "d73a4a" }],
      milestone: "v2",
      // The listing never asks for the conversation, so a row from it counts none.
      commentCount: 0,
    });
  });

  it("reads reaction totals without loading issue conversations", () => {
    const batch = expectSuccess(
      decodeIssueListJson(
        listJson([
          {
            reactionGroups: [{ content: "THUMBS_UP", reactors: { totalCount: 5, nodes: [] } }],
          },
        ]),
      ),
    );

    expect(batch.items[0]?.reactions).toEqual([
      { content: "thumbs-up", count: 5, actors: [], viewerHasReacted: false },
    ]);
  });

  it("reads why a closed issue was closed, and nothing for one still open", () => {
    const batch = expectSuccess(
      decodeIssueListJson(
        listJson([
          { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-07-03T00:00:00Z" },
          { state: "CLOSED", stateReason: "NOT_PLANNED" },
          // GitHub says an issue opened again was reopened, which is not why it was closed.
          { stateReason: "REOPENED" },
        ]),
      ),
    );

    expect(batch.items.map((item) => [item.state, item.stateReason, item.closedAt])).toEqual([
      ["closed", "completed", "2026-07-03T00:00:00Z"],
      ["closed", "not-planned", null],
      ["open", null, null],
    ]);
  });

  it("skips a malformed row but still counts it, so paging does not stop early", () => {
    const batch = expectSuccess(
      decodeIssueListJson(`[{"number":"not a number"},${issueJson({ number: 7 })}]`),
    );

    expect(batch.items.map((item) => item.number)).toEqual([7]);
    expect(batch.rawCount).toBe(2);
  });

  it("fails when GitHub answered with something that is not a list of issues", () => {
    expect(Result.isFailure(decodeIssueListJson('{"message":"Not Found"}'))).toBe(true);
  });

  it("never asks gh for the conversation, which it answers with in full", () => {
    // `--json comments` is every remark's whole body rather than a count, which is megabytes a
    // page. The search carries GitHub's own count instead.
    expect(ISSUE_LIST_JSON_FIELDS.split(",")).not.toContain("comments");
    expect(ISSUE_DETAIL_JSON_FIELDS.split(",")).toContain("body");
  });
});

describe("issue detail decoding", () => {
  it("reads the body GitHub answered with", () => {
    const detail = expectSuccess(decodeIssueDetailJson(issueJson({ body: "It 500s." })));

    expect(detail.body).toBe("It 500s.");
  });

  it("reads an issue with no body as one with an empty body", () => {
    expect(expectSuccess(decodeIssueDetailJson(issueJson({}))).body).toBe("");
  });
});

describe("created issue decoding", () => {
  it("answers with where the new issue lives", () => {
    expect(
      expectSuccess(
        decodeCreatedIssueJson('{"number":9,"html_url":"https://github.com/acme/web/issues/9"}'),
      ),
    ).toEqual({ number: 9, url: "https://github.com/acme/web/issues/9" });
  });
});

describe("issue search decoding", () => {
  it("files each row under the repository it came from, with GitHub's own comment count", () => {
    const batch = expectSuccess(
      decodeIssueSearchJson(
        searchJson([
          searchItem({
            comments: { totalCount: 12 },
            milestone: { title: "v2" },
            assignees: {
              nodes: [{ login: "julius", name: "Julius", avatarUrl: "https://avatars/julius" }],
            },
            labels: { nodes: [{ name: "bug", color: "d73a4a" }, null] },
          }),
          searchItem({
            number: 9,
            repository: { nameWithOwner: "pingdotgg/t3code" },
            state: "CLOSED",
            stateReason: "NOT_PLANNED",
          }),
        ]),
      ),
    );

    expect(batch.items.map((item) => [item.repository, item.number, item.commentCount])).toEqual([
      ["acme/web", 7, 12],
      ["pingdotgg/t3code", 9, 0],
    ]);
    expect(batch.items[0]).toMatchObject({
      // A search carries the faces the listing has none of.
      author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
      assignees: [{ login: "julius", name: "Julius", avatarUrl: "https://avatars/julius" }],
      labels: [{ name: "bug", color: "d73a4a" }],
      milestone: "v2",
    });
    expect(batch.items[1]?.stateReason).toBe("not-planned");
    expect(batch.rawCount).toBe(2);
    expect(batch.hasNextPage).toBe(false);
  });

  it("reads reaction totals from cross-repository search rows", () => {
    const batch = expectSuccess(
      decodeIssueSearchJson(
        searchJson([
          searchItem({
            reactionGroups: [{ content: "ROCKET", reactors: { totalCount: 3, nodes: [] } }],
          }),
        ]),
      ),
    );

    expect(batch.items[0]?.reactions?.[0]).toMatchObject({ content: "rocket", count: 3 });
  });

  it("skips a node that is not an issue but still counts it", () => {
    const batch = expectSuccess(
      // A node GitHub answered for something other than an issue decodes as empty, and a row
      // naming no repository cannot be filed under one.
      decodeIssueSearchJson(searchJson([{}, searchItem({ repository: null }), searchItem({})])),
    );

    expect(batch.items.map((item) => item.number)).toEqual([7]);
    expect(batch.rawCount).toBe(3);
  });

  it("reports that GitHub has more rows than the slice asked for", () => {
    const batch = expectSuccess(decodeIssueSearchJson(searchJson([searchItem({})], true)));

    expect(batch.hasNextPage).toBe(true);
  });

  // Where a search reads on to finish an instant, this is what it reads on from. GitHub sends an
  // `endCursor` on the last page too, so the flag is what decides, not the cursor.
  it("carries the cursor a search page ends on, and none once there is nothing after it", () => {
    expect(
      expectSuccess(decodeIssueSearchJson(searchJson([searchItem({})], true, "Y3Vyc29y")))
        .nextCursor,
    ).toBe("Y3Vyc29y");
    expect(
      expectSuccess(decodeIssueSearchJson(searchJson([searchItem({})], false, "Y3Vyc29y")))
        .nextCursor,
    ).toBeNull();
  });

  it("fails when GitHub answered something other than a search", () => {
    expect(Result.isFailure(decodeIssueSearchJson('{"errors":[{"message":"nope"}]}'))).toBe(true);
  });
});

describe("issue supplement decoding", () => {
  it("grants labelling and assigning to a role that has them, and to no other", () => {
    const triage = expectSuccess(
      decodeIssueSupplementJson(supplementJson({ viewerPermission: "TRIAGE" })),
    );
    const read = expectSuccess(
      decodeIssueSupplementJson(supplementJson({ viewerPermission: "READ" })),
    );

    expect(triage.viewer.canTriage).toBe(true);
    expect(read.viewer.canTriage).toBe(false);
  });

  it("grants updating where GitHub says nothing, and authorship only where it says so", () => {
    const unstated = expectSuccess(decodeIssueSupplementJson(supplementJson({})));
    const refused = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({ issue: { viewerCanUpdate: false, viewerDidAuthor: true } }),
      ),
    );

    // An absent permission is an unknown one, which the host's own refusal can still explain.
    expect(unstated.viewer).toEqual({ canTriage: false, canUpdate: true, didAuthor: false });
    expect(refused.viewer).toEqual({ canTriage: false, canUpdate: false, didAuthor: true });
  });

  it("collects the faces GitHub reports for the author and the assignees", () => {
    const supplement = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({
          issue: {
            author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
            assignees: {
              nodes: [
                { login: "julius", avatarUrl: "https://avatars/julius" },
                // Nothing to file: a login with no face, and a face belonging to nobody.
                { login: "hubot" },
                { avatarUrl: "https://avatars/ghost" },
                null,
              ],
            },
            comments: { totalCount: 4 },
          },
        }),
      ),
    );

    expect([...supplement.avatarsByLogin]).toEqual([
      ["bilal", "https://avatars/bilal"],
      ["julius", "https://avatars/julius"],
    ]);
    expect(supplement.commentCount).toBe(4);
  });

  it("reads a connected change request as one that closes the issue, and a mention as one that does not", () => {
    const supplement = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({
          issue: {
            timelineItems: {
              nodes: [
                { __typename: "ConnectedEvent", subject: pullRequestRef(12) },
                { __typename: "CrossReferencedEvent", source: pullRequestRef(13) },
              ],
            },
          },
        }),
      ),
    );

    expect(
      supplement.linkedPullRequests.map((link) => [link.number, link.closesIssue, link.state]),
    ).toEqual([
      [12, true, "open"],
      [13, false, "open"],
    ]);
  });

  it("drops a link that was later disconnected by hand", () => {
    const supplement = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({
          issue: {
            timelineItems: {
              nodes: [
                { __typename: "ConnectedEvent", subject: pullRequestRef(12) },
                {
                  __typename: "DisconnectedEvent",
                  subject: { number: 12, repository: { nameWithOwner: "ACME/Web" } },
                },
                { __typename: "ConnectedEvent", subject: pullRequestRef(13) },
              ],
            },
          },
        }),
      ),
    );

    // The same change request under a differently cased repository is the same link.
    expect(supplement.linkedPullRequests.map((link) => link.number)).toEqual([13]);
  });

  it("keeps one link for a change request seen twice, and the closing relationship of the two", () => {
    const supplement = expectSuccess(
      decodeIssueSupplementJson(
        supplementJson({
          issue: {
            closedByPullRequestsReferences: {
              // No `__typename`: these nodes are change requests by definition.
              nodes: [pullRequestRef(12, { __typename: undefined, state: "MERGED" })],
            },
            timelineItems: {
              nodes: [
                { __typename: "CrossReferencedEvent", source: pullRequestRef(12) },
                // A reference to another issue is a mention between issues, not the work for it.
                {
                  __typename: "CrossReferencedEvent",
                  source: {
                    __typename: "Issue",
                    number: 99,
                    repository: { nameWithOwner: "acme/web" },
                  },
                },
              ],
            },
          },
        }),
      ),
    );

    expect(
      supplement.linkedPullRequests.map((link) => [link.number, link.closesIssue, link.state]),
    ).toEqual([[12, true, "merged"]]);
  });

  it("answers for an issue GitHub says nothing about rather than failing the read", () => {
    const supplement = expectSuccess(decodeIssueSupplementJson(supplementJson({ issue: null })));

    expect(supplement.commentCount).toBe(0);
    expect(supplement.linkedPullRequests).toEqual([]);
    expect(supplement.viewer.didAuthor).toBe(false);
  });
});

describe("viewer permission decoding", () => {
  it("reads the viewer's standing on its own", () => {
    const access = expectSuccess(
      decodeIssueViewerPermissionsJson(
        JSON.stringify({
          data: {
            repository: {
              viewerPermission: "WRITE",
              issue: { viewerCanUpdate: true, viewerDidAuthor: false },
            },
          },
        }),
      ),
    );

    expect(access).toEqual({ canTriage: true, canUpdate: true, didAuthor: false });
  });

  it("fails when GitHub answered no repository at all", () => {
    expect(Result.isFailure(decodeIssueViewerPermissionsJson('{"data":{}}'))).toBe(true);
  });
});

describe("issue activity decoding", () => {
  it("reads the conversation with the faces the listing has none of", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson(
        activityJson({
          author: { login: "bilal", avatarUrl: "https://avatars/bilal" },
          viewer: "bilal",
          reactions: [
            {
              content: "ROCKET",
              viewerHasReacted: false,
              reactors: { totalCount: 1, nodes: [{ login: "julius" }] },
            },
          ],
          comments: {
            totalCount: 250,
            pageInfo: { hasPreviousPage: true, startCursor: "Y3Vyc29y" },
            nodes: [
              {
                id: "IC_1",
                reactionGroups: [
                  {
                    content: "HEART",
                    viewerHasReacted: true,
                    reactors: { totalCount: 2, nodes: [{ login: "bilal" }, { login: "julius" }] },
                  },
                ],
                author: { login: "julius", avatarUrl: "https://avatars/julius" },
                body: "Reproduced.",
                createdAt: "2026-07-02T00:00:00Z",
                url: "https://github.com/acme/web/issues/7#issuecomment-1",
              },
              // Nothing to address a remark by, so there is no remark.
              { id: "  ", createdAt: "2026-07-02T00:00:00Z" },
              null,
            ],
          },
        }),
      ),
    );

    expect(activity.author).toEqual({
      login: "bilal",
      name: null,
      avatarUrl: "https://avatars/bilal",
    });
    expect(activity.comments.map((comment) => [comment.id, comment.body])).toEqual([
      ["IC_1", "Reproduced."],
    ]);
    // GitHub's own count, which this bounded read fell well short of.
    expect(activity.commentCount).toBe(250);
    expect(activity.nextCursor).toBe("Y3Vyc29y");
    expect(activity.reactions).toEqual([
      { content: "rocket", count: 1, actors: ["julius"], viewerHasReacted: false },
    ]);
    expect(activity.comments[0]?.reactions).toEqual([
      { content: "heart", count: 2, actors: ["julius"], viewerHasReacted: true },
    ]);
  });

  it("carries on from nowhere once GitHub says the conversation is whole", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson(
        // GitHub sends a `startCursor` on the first page too, so the flag is what decides.
        activityJson({
          comments: {
            totalCount: 1,
            pageInfo: { hasPreviousPage: false, startCursor: "Y3Vyc29y" },
            nodes: [],
          },
        }),
      ),
    );

    expect(activity.nextCursor).toBe(null);
  });

  it("maps every timeline event GitHub reports onto what happened", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson(
        activityJson({
          timeline: [
            timelineEvent("ClosedEvent"),
            timelineEvent("ReopenedEvent"),
            timelineEvent("LabeledEvent", { label: { name: "bug" } }),
            timelineEvent("UnlabeledEvent", { label: { name: "bug" } }),
            timelineEvent("AssignedEvent", { assignee: { login: "julius" } }),
            timelineEvent("UnassignedEvent", { assignee: { login: "julius" } }),
            timelineEvent("RenamedTitleEvent", { currentTitle: "A better title" }),
            timelineEvent("MilestonedEvent", { milestoneTitle: "v2" }),
            timelineEvent("LockedEvent"),
            timelineEvent("UnlockedEvent"),
            timelineEvent("CrossReferencedEvent", {
              source: {
                __typename: "PullRequest",
                number: 12,
                repository: { nameWithOwner: "acme/web" },
              },
            }),
          ],
        }),
      ),
    );

    expect(activity.events.map((event) => [event.kind, event.detail])).toEqual([
      ["closed", null],
      ["reopened", null],
      ["labeled", "bug"],
      ["unlabeled", "bug"],
      ["assigned", "julius"],
      ["unassigned", "julius"],
      ["renamed", "A better title"],
      ["milestoned", "v2"],
      ["locked", null],
      ["unlocked", null],
      ["referenced", "acme/web#12"],
    ]);
    expect(activity.events[0]?.actor).toEqual({
      login: "julius",
      name: null,
      avatarUrl: "https://avatars/julius",
    });
  });

  it("drops an event kind it has no words for rather than guessing at one", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson(
        activityJson({
          timeline: [
            timelineEvent("TransferredEvent"),
            // Nothing to file a change under, and nothing to say when it happened.
            timelineEvent("ClosedEvent", { id: null }),
            timelineEvent("ClosedEvent", { createdAt: null }),
            timelineEvent("ClosedEvent", { id: "CE_kept", actor: null }),
          ],
        }),
      ),
    );

    expect(activity.events.map((event) => [event.id, event.actor])).toEqual([["CE_kept", null]]);
  });

  it("answers for an issue that is not there rather than failing the read", () => {
    const activity = expectSuccess(
      decodeIssueActivityJson('{"data":{"repository":{"issue":null}}}'),
    );

    expect(activity).toMatchObject({
      author: null,
      comments: [],
      commentCount: 0,
      nextCursor: null,
      events: [],
    });
  });
});

describe("issue comment page decoding", () => {
  it("reads the rest of a conversation in the shape the first page delivered it", () => {
    const page = expectSuccess(
      decodeIssueCommentsJson(
        JSON.stringify({
          data: {
            repository: {
              issue: {
                comments: {
                  totalCount: 250,
                  pageInfo: { hasPreviousPage: true, startCursor: "bmV4dA==" },
                  nodes: [{ id: "IC_2", body: "Still broken.", createdAt: "2026-07-04T00:00:00Z" }],
                },
              },
            },
          },
        }),
      ),
    );

    expect(page.comments.map((comment) => comment.id)).toEqual(["IC_2"]);
    expect(page.nextCursor).toBe("bmV4dA==");
  });
});

describe("repository label decoding", () => {
  it("reads the labels a repository offers, and skips one it named nothing", () => {
    const labels = expectSuccess(
      decodeRepositoryLabelsJson(
        JSON.stringify([
          { name: "bug", color: "d73a4a", description: "Something is broken" },
          { name: "   " },
          { color: "ffffff" },
        ]),
      ),
    );

    expect(labels.labels).toEqual([
      { name: "bug", color: "d73a4a", description: "Something is broken" },
    ]);
    // Counted before decoding, so a skipped label cannot end the walk through the pages early.
    expect(labels.rawCount).toBe(3);
  });

  it("fails when GitHub answered something that is not a list of labels", () => {
    expect(Result.isFailure(decodeRepositoryLabelsJson('{"message":"Not Found"}'))).toBe(true);
  });
});

describe("assignee candidate decoding", () => {
  it("marks whoever already has the issue, and leads with them", () => {
    const list = expectSuccess(
      decodeAssigneeCandidatesJson(
        JSON.stringify({
          data: {
            repository: {
              assignableUsers: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { login: "hubot", name: "Hubot", avatarUrl: "https://avatars/hubot" },
                  { login: "julius" },
                  null,
                ],
              },
              issue: {
                assignees: {
                  // Still assigned even though GitHub no longer counts them assignable.
                  nodes: [{ login: "ghost", name: "Ghost" }, { login: "julius" }],
                },
              },
            },
          },
        }),
      ),
    );

    expect(list.candidates.map((candidate) => [candidate.id, candidate.isAssigned])).toEqual([
      ["ghost", true],
      ["julius", true],
      ["hubot", false],
    ]);
    expect(list.truncated).toBe(false);
  });

  it("says the list is not all of them when GitHub has more people to offer", () => {
    const list = expectSuccess(
      decodeAssigneeCandidatesJson(
        JSON.stringify({
          data: {
            repository: {
              assignableUsers: { pageInfo: { hasNextPage: true }, nodes: [{ login: "hubot" }] },
              issue: null,
            },
          },
        }),
      ),
    );

    expect(list.truncated).toBe(true);
    expect(list.candidates.map((candidate) => candidate.isAssigned)).toEqual([false]);
  });
});

describe("issue template decoding", () => {
  it("reads a template's own words, and the filename it is addressed by", () => {
    const templates = expectSuccess(
      decodeIssueTemplatesJson(issueTemplatesJson([templateEntry()])),
    );

    expect(templates).toEqual([
      {
        key: "bug_report.md",
        name: "Bug report",
        about: "File a bug",
        title: "Bug: ",
        body: "### Steps",
        labels: ["bug"],
        assignees: ["julius"],
      },
    ]);
  });

  it("offers a template under its filename when it names itself nothing else", () => {
    const templates = expectSuccess(
      decodeIssueTemplatesJson(
        issueTemplatesJson([
          templateEntry({
            name: null,
            about: null,
            title: null,
            body: null,
            assignees: null,
            labels: null,
          }),
        ]),
      ),
    );

    expect(templates).toEqual([
      {
        key: "bug_report.md",
        name: "bug_report.md",
        about: "",
        title: "",
        body: "",
        labels: [],
        assignees: [],
      },
    ]);
  });

  it("skips a template GitHub answered nothing readable for, and keeps the rest", () => {
    const templates = expectSuccess(
      decodeIssueTemplatesJson(
        issueTemplatesJson([
          // No filename to address it by, so there is nothing to key it under.
          { name: "No filename" },
          templateEntry({ filename: "feature_request.md" }),
        ]),
      ),
    );

    expect(templates.map((template) => template.key)).toEqual(["feature_request.md"]);
  });

  it("answers with no templates for a repository GitHub reports none for", () => {
    expect(expectSuccess(decodeIssueTemplatesJson(issueTemplatesJson(null)))).toEqual([]);
  });

  it("fails when GitHub answered something that is not a repository", () => {
    expect(Result.isFailure(decodeIssueTemplatesJson('{"message":"Not Found"}'))).toBe(true);
  });
});

describe("issue template config decoding", () => {
  it("reads a config file's own settings for the chooser", () => {
    const config = decodeIssueTemplateConfigYaml(
      `blank_issues_enabled: false
contact_links:
  - name: Community support
    url: https://example.com/discuss
    about: Ask the community
`,
    );

    expect(config).toEqual({
      blankIssuesEnabled: false,
      contactLinks: [
        {
          name: "Community support",
          url: "https://example.com/discuss",
          about: "Ask the community",
        },
      ],
    });
  });

  it("answers with GitHub's own defaults for a config file that will not parse", () => {
    expect(decodeIssueTemplateConfigYaml("blank_issues_enabled: [not: closed")).toEqual(
      DEFAULT_ISSUE_TEMPLATE_CONFIG,
    );
  });

  it("answers with GitHub's own defaults for a file with nothing to configure", () => {
    // Absent, and parsed to a scalar or a list rather than to the mapping the file is meant to be.
    expect(decodeIssueTemplateConfigYaml("")).toEqual(DEFAULT_ISSUE_TEMPLATE_CONFIG);
    expect(decodeIssueTemplateConfigYaml("just some text")).toEqual(DEFAULT_ISSUE_TEMPLATE_CONFIG);
    expect(decodeIssueTemplateConfigYaml("- one\n- two\n")).toEqual(DEFAULT_ISSUE_TEMPLATE_CONFIG);
  });

  it("skips a contact link GitHub cannot open, and keeps the others", () => {
    const config = decodeIssueTemplateConfigYaml(
      `contact_links:
  - name: No URL
    about: Missing what it points to
  - name: Blank URL
    url: "   "
  - name: Community support
    url: https://example.com/discuss
`,
    );

    expect(config.contactLinks).toEqual([
      { name: "Community support", url: "https://example.com/discuss", about: "" },
    ]);
  });
});

describe("issue form decoding", () => {
  it("reads every kind of question a form can ask, in the order it asks them", () => {
    const form = decodeIssueFormYaml(
      "bug_report.yml",
      `name: Bug report
description: File a bug
title: "Bug: "
labels:
  - bug
  - triage
assignees:
  - julius
body:
  - type: markdown
    attributes:
      value: Thanks for reporting!
  - type: input
    id: repro-url
    attributes:
      label: Reproduction URL
      description: Where can we see this happen?
      placeholder: https://example.com
  - type: textarea
    id: logs
    attributes:
      label: Relevant log output
      description: Paste any relevant log output
      render: shell
    validations:
      required: true
  - type: dropdown
    id: browsers
    attributes:
      label: Which browsers?
      multiple: true
      options:
        - Chrome
        - Firefox
        - Safari
  - type: checkboxes
    id: terms
    attributes:
      label: Code of Conduct
      options:
        - label: I agree
          required: true
        - label: Newsletter opt-in
`,
    );

    expect(form).toEqual({
      key: "bug_report.yml",
      name: "Bug report",
      about: "File a bug",
      title: "Bug: ",
      // A form has no draft to write over: its body is built from the answers instead.
      body: "",
      labels: ["bug", "triage"],
      assignees: ["julius"],
      fields: [
        { kind: "markdown", value: "Thanks for reporting!" },
        {
          kind: "input",
          id: "repro-url",
          label: "Reproduction URL",
          description: "Where can we see this happen?",
          placeholder: "https://example.com",
          value: "",
          required: false,
        },
        {
          kind: "textarea",
          id: "logs",
          label: "Relevant log output",
          description: "Paste any relevant log output",
          placeholder: "",
          value: "",
          render: "shell",
          required: true,
        },
        {
          kind: "dropdown",
          id: "browsers",
          label: "Which browsers?",
          description: "",
          options: ["Chrome", "Firefox", "Safari"],
          multiple: true,
          required: false,
        },
        {
          kind: "checkboxes",
          id: "terms",
          label: "Code of Conduct",
          description: "",
          options: [
            { label: "I agree", required: true },
            { label: "Newsletter opt-in", required: false },
          ],
        },
      ],
    });
  });

  it("drops a question of a kind this composer has no control for, and keeps the ones around it", () => {
    const form = decodeIssueFormYaml(
      "colors.yml",
      `name: Colors
body:
  - type: input
    id: before
    attributes:
      label: Before
  - type: colorpicker
    id: color
    attributes:
      label: Pick a color
  - type: input
    id: after
    attributes:
      label: After
`,
    );

    expect(form?.fields?.map((field) => (field.kind === "input" ? field.id : field.kind))).toEqual([
      "before",
      "after",
    ]);
  });

  it("addresses an unnamed question by its place in the whole body, not just among questions", () => {
    const form = decodeIssueFormYaml(
      "no_id.yml",
      `name: No id
body:
  - type: markdown
    attributes:
      value: intro
  - type: input
    attributes:
      label: Your answer
`,
    );

    const input = form?.fields?.[1];
    expect(input?.kind === "input" ? input.id : null).toBe("field-1");
  });

  // The stand-in is built from a place in the body, which is a name a form is free to have given
  // another question. Sharing it would mean sharing an answer: one control writes over the other,
  // and the issue is filed with one answer twice and the other not at all.
  it("keeps an unnamed question off an id the form gives another one", () => {
    const form = decodeIssueFormYaml(
      "clash.yml",
      `name: Clash
body:
  - type: markdown
    attributes:
      value: intro
  - type: input
    attributes:
      label: Unnamed
  - type: input
    id: field-1
    attributes:
      label: Named
`,
    );

    expect(
      form?.fields?.map((field) => (field.kind === "markdown" ? field.kind : field.id)),
    ).toEqual(["markdown", "field-1-2", "field-1"]);
  });

  it("gives the second of two questions the form named the same thing an answer of its own", () => {
    const form = decodeIssueFormYaml(
      "twice.yml",
      `name: Twice
body:
  - type: input
    id: version
    attributes:
      label: Version
  - type: textarea
    id: version
    attributes:
      label: Version details
`,
    );

    expect(
      form?.fields?.map((field) => (field.kind === "markdown" ? field.kind : field.id)),
    ).toEqual(["version", "version-2"]);
  });

  it("answers null for a file that will not parse as YAML at all", () => {
    expect(decodeIssueFormYaml("broken.yml", 'name: "Bug report')).toBeNull();
  });

  it("answers null for a file that parses but names no form", () => {
    expect(decodeIssueFormYaml("about.yml", '{"about":"x"}')).toBeNull();
  });

  it("reads labels written as one comma-separated line the same as a list of them", () => {
    const form = decodeIssueFormYaml("labels.yml", "name: Simple\nlabels: bug, triage\nbody: []\n");

    expect(form?.labels).toEqual(["bug", "triage"]);
  });
});

describe("issue template forms decoding", () => {
  const bugReportYaml = `name: Bug report
body:
  - type: input
    id: repro
    attributes:
      label: Reproduction
`;
  const featureRequestYaml = `name: Feature request
body:
  - type: input
    id: motivation
    attributes:
      label: Motivation
`;

  it("reads every form in the directory, and skips everything that is not one", () => {
    const forms = expectSuccess(
      decodeIssueTemplateFormsJson(
        issueTemplateFormsJson({
          entries: [
            { name: "bug_report.yml", object: { text: bugReportYaml } },
            { name: "feature_request.yaml", object: { text: featureRequestYaml } },
            // The chooser's own settings, not one of the things it offers.
            { name: "config.yml", object: { text: "blank_issues_enabled: true" } },
            // A markdown template, read through `issueTemplates` instead.
            { name: "compliment.md", object: { text: "### Nice work" } },
            // One bad file must not cost the directory the forms around it.
            { name: "broken.yml", object: { text: 'name: "Unbalanced' } },
            // A directory entry: no `... on Blob` fragment, so no text comes back for it.
            { name: "assets", object: {} },
          ],
        }),
      ),
    );

    expect(forms.forms.map((form) => form.name)).toEqual(["Bug report", "Feature request"]);
  });

  it("points the contributing guidelines at the root file first, then .github, then docs", () => {
    const root = expectSuccess(
      decodeIssueTemplateFormsJson(
        issueTemplateFormsJson({
          rootGuidelines: { __typename: "Blob" },
          dotGitHubGuidelines: { __typename: "Blob" },
          docsGuidelines: { __typename: "Blob" },
        }),
      ),
    );
    const dotGitHub = expectSuccess(
      decodeIssueTemplateFormsJson(
        issueTemplateFormsJson({
          dotGitHubGuidelines: { __typename: "Blob" },
          docsGuidelines: { __typename: "Blob" },
        }),
      ),
    );
    const docs = expectSuccess(
      decodeIssueTemplateFormsJson(
        issueTemplateFormsJson({ docsGuidelines: { __typename: "Blob" } }),
      ),
    );
    const none = expectSuccess(decodeIssueTemplateFormsJson(issueTemplateFormsJson({})));

    expect(root.contributingGuidelinesUrl).toBe(
      "https://github.com/acme/web/blob/HEAD/CONTRIBUTING.md",
    );
    expect(dotGitHub.contributingGuidelinesUrl).toBe(
      "https://github.com/acme/web/blob/HEAD/.github/CONTRIBUTING.md",
    );
    expect(docs.contributingGuidelinesUrl).toBe(
      "https://github.com/acme/web/blob/HEAD/docs/CONTRIBUTING.md",
    );
    expect(none.contributingGuidelinesUrl).toBeUndefined();
  });

  it("answers with no forms for a repository that keeps no template directory", () => {
    const forms = expectSuccess(
      decodeIssueTemplateFormsJson(issueTemplateFormsJson({ entries: null })),
    );

    expect(forms.forms).toEqual([]);
  });
});

describe("issue write bodies", () => {
  it("writes only the fields the edit carried, so a rename cannot blank a body", () => {
    expect(buildIssueWriteJson({ title: "A better title" })).toBe('{"title":"A better title"}');
  });

  it("writes an empty set, which is how the whole set is taken off", () => {
    expect(buildIssueWriteJson({ labels: [], assignees: [] })).toBe('{"labels":[],"assignees":[]}');
  });

  it("keeps a body that reads as JSON as text", () => {
    expect(buildIssueWriteJson({ body: "true" })).toBe('{"body":"true"}');
  });

  it("carries the document and the reader's own words in one request body", () => {
    const raw = encodeGraphQlRequestJson({
      query: "query($q: String!) { search(query: $q) { nodes { __typename } } }",
      variables: { q: 'is:issue "a b"' },
    });

    expect(JSON.parse(raw)).toEqual({
      query: "query($q: String!) { search(query: $q) { nodes { __typename } } }",
      variables: { q: 'is:issue "a b"' },
    });
  });
});

describe("issue search document", () => {
  it("asks GitHub's issue index for issues, so a pull request cannot arrive as one", () => {
    const query = issueSearchGraphQlQuery(10);

    // Both halves are needed: the index holds pull requests too, and only the fragment says
    // which of the two a node has to be.
    expect(query).toContain("type: ISSUE");
    expect(query).toContain("... on Issue");
    expect(query).toContain("first: 10");
    // The cursor is how one instant holding more rows than a page is read whole.
    expect(query).toContain("after: $cursor");
  });

  it("clamps the page to what GitHub's search will serve", () => {
    expect(issueSearchGraphQlQuery(500)).toContain(`first: ${ISSUE_SEARCH_MAX_ROWS}`);
    expect(issueSearchGraphQlQuery(0)).toContain("first: 1");
  });
});
