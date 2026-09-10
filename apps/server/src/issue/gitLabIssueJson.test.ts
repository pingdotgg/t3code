import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeCreatedIssueJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssueNotesJson,
  decodeLabelEventsJson,
  decodeLinkedMergeRequestsJson,
  decodeProjectLabelsJson,
  decodeProjectMembersJson,
  decodeViewerJson,
} from "./gitLabIssueJson.ts";

function issueJson(entry: Record<string, unknown>): string {
  return JSON.stringify({
    iid: 1,
    title: "The page never loads",
    web_url: "https://gitlab.com/acme/web/-/issues/1",
    state: "opened",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    ...entry,
  });
}

function listJson(entries: ReadonlyArray<Record<string, unknown>>): string {
  return `[${entries.map((entry) => issueJson(entry)).join(",")}]`;
}

function mergeRequestJson(entry: Record<string, unknown>): string {
  return JSON.stringify({
    iid: 12,
    title: "Fix the page",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/12",
    references: { full: "acme/web!12" },
    ...entry,
  });
}

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("decodeIssueListJson", () => {
  it("reads an issue with its people, labels and milestone", () => {
    const batch = expectSuccess(
      decodeIssueListJson(
        listJson([
          {
            iid: 42,
            author: { username: "bilal", name: "Bilal", avatar_url: "https://avatars/b.png" },
            assignees: [{ id: 5, username: "julius" }, { username: "  " }],
            labels: ["backend", "   "],
            milestone: { title: "v2" },
            user_notes_count: 3,
          },
        ]),
      ),
    );

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]).toMatchObject({
      number: 42,
      state: "open",
      stateReason: null,
      author: { login: "bilal", name: "Bilal", avatarUrl: "https://avatars/b.png" },
      assignees: [{ login: "julius", name: null, avatarUrl: null }],
      // GitLab hands out label names only, so there is no colour to carry.
      labels: [{ name: "backend", color: null }],
      milestone: "v2",
      commentCount: 3,
    });
  });

  it("reads a closed issue as closed, with the instant it happened", () => {
    const batch = expectSuccess(
      decodeIssueListJson(listJson([{ state: "closed", closed_at: "2026-07-03T00:00:00Z" }])),
    );

    expect(batch.items[0]).toMatchObject({
      state: "closed",
      closedAt: "2026-07-03T00:00:00Z",
      // GitLab records no reason, whatever the reason was.
      stateReason: null,
    });
  });

  it("counts no remarks for an issue GitLab reports none for", () => {
    const batch = expectSuccess(decodeIssueListJson(listJson([{}])));

    expect(batch.items[0]).toMatchObject({ commentCount: 0, milestone: null, author: null });
  });

  it("skips a malformed row but still counts it, so paging does not stop early", () => {
    const batch = expectSuccess(
      decodeIssueListJson(`[{"iid":"not a number"},${listJson([{ iid: 7 }]).slice(1)}`),
    );

    expect(batch.items.map((item) => item.number)).toEqual([7]);
    expect(batch.rawIndexes).toEqual([1]);
    expect(batch.rawCount).toBe(2);
  });

  it("fails when GitLab did not return a list", () => {
    expect(Result.isFailure(decodeIssueListJson('{"message":"404 Project Not Found"}'))).toBe(true);
  });
});

describe("decodeIssueDetailJson", () => {
  it("reads the description as the body", () => {
    const detail = expectSuccess(decodeIssueDetailJson(issueJson({ description: "It 500s." })));

    expect(detail.body).toBe("It 500s.");
  });

  it("reads an issue with no description as one with an empty body", () => {
    expect(expectSuccess(decodeIssueDetailJson(issueJson({ description: null }))).body).toBe("");
  });
});

describe("decodeCreatedIssueJson", () => {
  it("answers with where the new issue lives", () => {
    expect(expectSuccess(decodeCreatedIssueJson(issueJson({ iid: 9 })))).toEqual({
      number: 9,
      url: "https://gitlab.com/acme/web/-/issues/1",
    });
  });
});

describe("decodeViewerJson", () => {
  it("reads the signed-in username", () => {
    expect(expectSuccess(decodeViewerJson(JSON.stringify({ username: "bilal" })))).toBe("bilal");
  });

  it("returns nothing when the account has no username", () => {
    expect(expectSuccess(decodeViewerJson(JSON.stringify({ username: "  " })))).toBeNull();
  });
});

describe("decodeIssueNotesJson", () => {
  it("splits what people wrote from what GitLab recorded", () => {
    const notes = expectSuccess(
      decodeIssueNotesJson(
        JSON.stringify([
          { id: 1, body: "closed", system: true, created_at: "2026-07-01T00:00:00Z" },
          {
            id: 2,
            body: "Reproduced on staging.",
            author: { username: "julius" },
            created_at: "2026-07-02T00:00:00Z",
          },
          { id: 3, body: "   ", created_at: "2026-07-03T00:00:00Z" },
          { id: "not a number", body: "nope", created_at: "2026-07-04T00:00:00Z" },
        ]),
      ),
    );

    expect(notes.comments).toEqual([
      {
        id: "2",
        author: { login: "julius", name: null, avatarUrl: null },
        body: "Reproduced on staging.",
        createdAt: "2026-07-02T00:00:00Z",
        url: null,
      },
    ]);
    expect(notes.events).toEqual([
      {
        id: "note-1",
        kind: "closed",
        actor: null,
        createdAt: "2026-07-01T00:00:00Z",
        detail: null,
      },
    ]);
    // The raw count keeps the dropped notes visible to the caller, which needs them to page.
    expect(notes.rawCount).toBe(4);
  });

  it("reads the system notes whose wording has been stable", () => {
    const notes = expectSuccess(
      decodeIssueNotesJson(
        JSON.stringify(
          [
            "reopened",
            "locked this issue",
            "unlocked this issue",
            "assigned to @bilal",
            "unassigned @julius",
            "mentioned in merge request !12",
            "changed title from **old {-title-}** to **new {+title+}**",
            'changed milestone to %"v2"',
          ].map((body, index) => ({
            id: index + 1,
            body,
            system: true,
            created_at: "2026-07-01T00:00:00Z",
          })),
        ),
      ),
    );

    expect(notes.events.map((event) => [event.kind, event.detail])).toEqual([
      ["reopened", null],
      ["locked", null],
      ["unlocked", null],
      ["assigned", "bilal"],
      ["unassigned", "julius"],
      ["referenced", "merge request !12"],
      ["renamed", "title"],
      ["milestoned", "v2"],
    ]);
  });

  it("drops a system note it cannot read rather than guessing what happened", () => {
    const notes = expectSuccess(
      decodeIssueNotesJson(
        JSON.stringify([
          // A labelling names its label by id here, which is why they are read elsewhere.
          { id: 1, body: "added ~7 label", system: true, created_at: "2026-07-01T00:00:00Z" },
          { id: 2, body: "did something new", system: true, created_at: "2026-07-01T00:00:00Z" },
        ]),
      ),
    );

    expect(notes.events).toEqual([]);
    expect(notes.rawCount).toBe(2);
  });
});

describe("decodeLabelEventsJson", () => {
  it("reads a labelling and an unlabelling", () => {
    const events = expectSuccess(
      decodeLabelEventsJson(
        JSON.stringify([
          {
            id: 1,
            action: "add",
            created_at: "2026-07-01T00:00:00Z",
            user: { username: "bilal" },
            label: { name: "backend" },
          },
          { id: 2, action: "remove", created_at: "2026-07-02T00:00:00Z", label: { name: "bug" } },
        ]),
      ),
    );

    expect(events.events.map((event) => [event.id, event.kind, event.detail])).toEqual([
      ["label-1", "labeled", "backend"],
      ["label-2", "unlabeled", "bug"],
    ]);
    expect(events.rawCount).toBe(2);
  });

  it("keeps a labelling whose label has since been deleted, with nothing to name", () => {
    const events = expectSuccess(
      decodeLabelEventsJson(
        JSON.stringify([{ id: 1, action: "add", created_at: "2026-07-01T00:00:00Z", label: null }]),
      ),
    );

    expect(events.events[0]?.detail).toBeNull();
  });

  it("skips an action it has no kind for, and a malformed row, but counts both", () => {
    const events = expectSuccess(
      decodeLabelEventsJson(
        JSON.stringify([
          { id: 1, action: "reordered", created_at: "2026-07-01T00:00:00Z" },
          { action: "add", created_at: "2026-07-01T00:00:00Z" },
        ]),
      ),
    );

    expect(events.events).toEqual([]);
    expect(events.rawCount).toBe(2);
  });
});

describe("decodeLinkedMergeRequestsJson", () => {
  it("marks the merge requests that close the issue as closing it", () => {
    const links = expectSuccess(
      decodeLinkedMergeRequestsJson(`[${mergeRequestJson({ state: "merged" })}]`, true),
    );

    expect(links.links).toEqual([
      {
        repository: "acme/web",
        number: 12,
        title: "Fix the page",
        url: "https://gitlab.com/acme/web/-/merge_requests/12",
        state: "merged",
        isDraft: false,
        closesIssue: true,
      },
    ]);
  });

  it("maps GitLab's merge request states onto the three the page knows", () => {
    const states = ["opened", "locked", "closed", "merged", undefined];
    const links = expectSuccess(
      decodeLinkedMergeRequestsJson(
        `[${states.map((state) => mergeRequestJson({ state })).join(",")}]`,
        false,
      ),
    );

    // A locked merge request is an open one whose discussion is locked.
    expect(links.links.map((link) => link.state)).toEqual([
      "open",
      "open",
      "closed",
      "merged",
      "open",
    ]);
    expect(links.links.every((link) => !link.closesIssue)).toBe(true);
  });

  it("reads the draft flag under either of the names GitLab has used", () => {
    const links = expectSuccess(
      decodeLinkedMergeRequestsJson(
        `[${mergeRequestJson({ draft: true })},${mergeRequestJson({ work_in_progress: true })}]`,
        false,
      ),
    );

    expect(links.links.map((link) => link.isDraft)).toEqual([true, true]);
  });

  it("skips a merge request that never names its own project", () => {
    const links = expectSuccess(
      decodeLinkedMergeRequestsJson(
        `[${mergeRequestJson({ references: null })},${mergeRequestJson({})}]`,
        false,
      ),
    );

    // A link with no repository cannot be opened, and there is nowhere else to get one from.
    expect(links.links.map((link) => link.repository)).toEqual(["acme/web"]);
    // The raw count is what says whether the host had more, so the skipped row still counts.
    expect(links.rawCount).toBe(2);
  });
});

describe("decodeProjectLabelsJson", () => {
  it("reads the labels a project offers", () => {
    const labels = expectSuccess(
      decodeProjectLabelsJson(
        JSON.stringify([
          { name: "backend", color: "#ff0000", description: "Server work" },
          { name: "  " },
          { color: "#00ff00" },
        ]),
      ),
    );

    expect(labels.labels).toEqual([
      { name: "backend", color: "#ff0000", description: "Server work" },
    ]);
    // The raw count is what says whether the host had more, so the skipped rows still count.
    expect(labels.rawCount).toBe(3);
  });
});

describe("decodeProjectMembersJson", () => {
  it("carries the numeric id an assignment is written with", () => {
    const members = expectSuccess(
      decodeProjectMembersJson(
        JSON.stringify([
          { id: 5, username: "julius", name: "Julius" },
          // No id, so there is nothing GitLab would take for this person.
          { username: "hubot" },
          { id: 9 },
        ]),
      ),
    );

    expect(members.members).toEqual([
      { id: "5", login: "julius", name: "Julius", avatarUrl: null },
    ]);
    expect(members.rawCount).toBe(3);
  });
});
