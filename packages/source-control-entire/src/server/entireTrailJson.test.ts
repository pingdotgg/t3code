import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as Fixtures from "./entireFixtures.ts";
import * as Json from "./entireTrailJson.ts";

const decodeTrail = Schema.decodeUnknownSync(Json.EntireTrail);
const decodeTrails = Schema.decodeUnknownSync(Json.EntireTrails);
const decodeDiscussions = Schema.decodeUnknownSync(Json.EntireDiscussions);
const decodeDetail = Schema.decodeUnknownSync(Json.EntireTrailDetail);
const decodeTimeline = Schema.decodeUnknownSync(Json.EntireTimeline);
const decodeDiscussion = Schema.decodeUnknownSync(Json.EntireDiscussion);

describe("entireTrailJson", () => {
  it("reads a list row as an open trail, keeping its own link and reviewers", () => {
    const item = Json.toChangeRequest(decodeTrail(Fixtures.trail), "gh/acme/web");
    assert.deepInclude(item, {
      number: 7,
      url: "https://entire.com/gh/acme/web/trails/7/add-the-thing",
      headBranch: "feature",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      reviewDecision: "changes-requested",
    });
    assert.deepStrictEqual(item.author, {
      login: "alice",
      name: "Alice",
      avatarUrl: "https://avatars.example/a.png",
    });
    // A reviewer with no resolvable login is left out rather than shown blank.
    assert.deepStrictEqual(item.reviewRequestLogins, ["bob"]);
  });

  it("reads past one row with a blank title, check, event or message id", () => {
    const page = decodeTrails({
      items: [Fixtures.trail, { ...Fixtures.trail, number: 8, title: " " }],
    });
    assert.deepStrictEqual(
      page.items.map((trail) => Json.toChangeRequest(trail, "gh/acme/web").title),
      ["Add the thing", "Trail #8"],
    );
    const { checks } = Fixtures.detail.mergeability;
    const detail = decodeDetail({
      ...Fixtures.detail,
      mergeability: {
        ...Fixtures.detail.mergeability,
        checks: { ...checks, runs: [...checks.runs, { name: "", status: "completed" }] },
      },
    });
    assert.deepStrictEqual(
      Json.toChecks(detail, "gh/acme/web").map((check) => check.name),
      ["build", "lint"],
    );
    const blank = { id: "", author: "bob", created_at: "2026-10-01T12:50:00.000Z", body: "?" };
    const activity = Json.toActivity({
      timeline: decodeTimeline({
        items: [
          ...Fixtures.timeline.items,
          {
            id: " ",
            kind: "approval",
            occurredAt: "2026-10-01T12:00:00Z",
            approvalStatus: "approved",
          },
        ],
      }),
      discussions: [
        decodeDiscussion({
          discussion: Fixtures.discussions.items[0],
          messages: [{ ...blank, replies: [blank] }],
        }),
      ],
      discussionsTruncated: false,
    });
    assert.deepStrictEqual(
      activity.comments.map((comment) => comment.id),
      ["trail-approval-1"],
    );
    assert.strictEqual(
      decodeDiscussions({
        items: [...Fixtures.discussions.items, { ...Fixtures.discussions.items[0], id: "" }],
      }).items.length,
      3,
    );
  });

  it.each([
    ["draft", "open", true],
    ["in_review", "open", false],
    ["merged", "merged", false],
    ["closed", "closed", false],
  ] as const)("reads status %s as %s", (status, state, isDraft) => {
    const item = Json.toChangeRequest(decodeTrail({ ...Fixtures.trail, status }), "gh/acme/web");
    assert.strictEqual(item.state, state);
    assert.strictEqual(item.isDraft, isDraft);
  });

  it("writes a description back without the project trail link it was shown with", () => {
    const parent = { number: 1070, url: "https://entire.com/et/acme/-/trails/1070" };
    const detail = decodeDetail({
      ...Fixtures.detail,
      parent,
      body_document: { text_snapshot: "Why" },
    });
    assert.strictEqual(Json.ownBody(detail, Json.changeBody(detail)), "Why");
    assert.strictEqual(
      Json.ownBody(detail, `${Json.changeBody(detail)}\n\nAnd how`),
      "Why\n\nAnd how",
    );
    // A link the reader rewrote is theirs to keep.
    assert.strictEqual(
      Json.ownBody(detail, "Part of trail [#1] on Entire.\n\nWhy"),
      "Part of trail [#1] on Entire.\n\nWhy",
    );
  });

  it("opens a change's description with its project trail, and only an Entire one", () => {
    const parent = { number: 1070, url: "https://entire.com/et/acme/-/trails/1070" };
    const detail = (fields: object) => decodeDetail({ ...Fixtures.detail, ...fields });
    assert.strictEqual(
      Json.changeBody(detail({ parent, body_document: { text_snapshot: "Why" } })),
      "Part of trail [#1070](https://entire.com/et/acme/-/trails/1070) on Entire.\n\nWhy",
    );
    assert.strictEqual(
      Json.changeBody(detail({ parent, body_document: undefined })),
      "Part of trail [#1070](https://entire.com/et/acme/-/trails/1070) on Entire.",
    );
    assert.strictEqual(
      Json.changeBody(
        detail({
          parent: { number: 1070, url: "https://evil.example/et/acme/-/trails/1070" },
          body_document: { text_snapshot: "Why" },
        }),
      ),
      "Why",
    );
  });

  it("links to entire.com when the server's link is some other page", () => {
    const item = Json.toChangeRequest(
      decodeTrail({ ...Fixtures.trail, url: "https://console.example/trails/7" }),
      "gh/acme/web",
    );
    assert.strictEqual(item.url, "https://entire.com/gh/acme/web/trails/7");
  });

  it("reads checks only from a complete read, and the viewer's actions from availability", () => {
    const detail = decodeDetail(Fixtures.detail);
    const checks = Json.toChecks(detail, "gh/acme/web");
    assert.deepStrictEqual(
      checks.map((check) => [check.name, check.status]),
      [
        ["build", "success"],
        ["lint", "pending"],
      ],
    );
    assert.strictEqual(Json.toChecksState(checks), "pending");
    // A cancelled run did not pass, as GitHub counts it.
    assert.strictEqual(
      Json.toChecksState(checks.map((check) => ({ ...check, status: "cancelled" as const }))),
      "failing",
    );
    assert.deepStrictEqual(
      Json.toChecks(
        decodeDetail({
          ...Fixtures.detail,
          mergeability: {
            ...Fixtures.detail.mergeability,
            checks: { ...Fixtures.detail.mergeability.checks, availability: "unavailable" },
          },
        }),
        "gh/acme/web",
      ),
      [],
    );
    assert.strictEqual(Json.headSha(detail), Fixtures.HEAD_SHA);
    const permissions = Json.toViewerPermissions(detail, "gh/acme/web");
    assert.deepStrictEqual(permissions.actions, ["draft", "close", "merge"]);
    // Entire took requesting changes out of its CLI; it is asked for on entire.com. Publishing
    // line comments takes push access, as approving does.
    assert.deepStrictEqual(permissions.verdicts, ["comment", "approve"]);

    const denied = Json.toViewerPermissions(decodeDetail(Fixtures.denied), "gh/acme/web");
    assert.deepStrictEqual(denied.actions, []);
    assert.deepStrictEqual(denied.verdicts, []);
    assert.isFalse(denied.resolve);
    assert.isTrue(permissions.editChangeRequest);
    assert.isFalse(denied.editChangeRequest);
  });

  it("offers a writer Merge on an open trail before its gates pass, and no one else", () => {
    for (const held of [Fixtures.gated, Fixtures.blocked])
      assert.deepStrictEqual(Json.toViewerPermissions(decodeDetail(held), "gh/acme/web").actions, [
        "draft",
        "close",
        "merge",
      ]);
    assert.deepStrictEqual(
      Json.toViewerPermissions(
        decodeDetail({ ...Fixtures.detail, status: "merged" }),
        "gh/acme/web",
      ).actions,
      [],
    );
    assert.deepStrictEqual(
      Json.toViewerPermissions(
        decodeDetail({ ...Fixtures.detail, status: "closed" }),
        "gh/acme/web",
      ).actions,
      ["reopen"],
    );
  });

  it("offers neither ready nor draft where the repository has no approvals gate", () => {
    const detail = decodeDetail(Fixtures.approvalsDisabled);
    assert.isFalse(Json.toDetailChangeRequest(detail, "gh/acme/web").isDraft);
    const permissions = Json.toViewerPermissions(detail, "gh/acme/web");
    assert.deepStrictEqual(permissions.actions, ["close", "merge"]);
    assert.deepStrictEqual(permissions.verdicts, ["comment"]);
  });

  it("offers a writer Update branch on an open trail Entire hosts, and on no mirror", () => {
    const offered = (fields: object, repository = "et/acme/web") =>
      Json.toViewerPermissions(decodeDetail({ ...Fixtures.detail, ...fields }), repository);
    assert.deepStrictEqual(offered({}).actions, ["draft", "close", "merge", "update-branch"]);
    assert.deepStrictEqual(offered({}).updateMethods, ["merge"]);
    // Entire refuses it for a trail backed by a pull request, which updates on its forge.
    for (const permissions of [
      offered({ gh_pr_id: 42 }),
      offered({}, "gh/acme/web"),
      offered({ status: "closed" }),
      offered(Fixtures.denied),
    ]) {
      assert.notInclude(permissions.actions, "update-branch");
      assert.deepStrictEqual(permissions.updateMethods, []);
    }
  });

  describe("a trail its gates hold back", () => {
    const blocked = decodeDetail(Fixtures.blocked);
    const repo = "gh/acme/web";

    it("needs a review while the approvals gate fails, and is approved once it passes", () => {
      assert.strictEqual(
        Json.toDetailChangeRequest(blocked, repo).reviewDecision,
        "review-required",
      );
      const passed = decodeDetail({
        ...Fixtures.blocked,
        mergeability: {
          ...Fixtures.blocked.mergeability,
          gates: [{ ...Fixtures.blocked.mergeability.gates[0], status: "passed" }],
        },
      });
      assert.strictEqual(Json.toDetailChangeRequest(passed, repo).reviewDecision, "approved");
      // A reviewer's request for changes still says so.
      assert.strictEqual(
        Json.toDetailChangeRequest(
          decodeDetail({ ...Fixtures.blocked, reviewers: Fixtures.trail.reviewers }),
          repo,
        ).reviewDecision,
        "changes-requested",
      );
    });

    it("lists its other blocking gates beside the CI runs, once each", () => {
      const checks = Json.toChecks(blocked, repo);
      assert.deepStrictEqual(
        checks.map((check) => [check.name, check.status, check.description]),
        [
          ["Entire: findings", "failure", "Unresolved findings: 1 without a severity"],
          ["build", "success", "Buildkite"],
          ["lint", "pending", null],
          ["Entire: up_to_date", "success", null],
          ["Entire: base_checks", "pending", null],
        ],
      );
      assert.strictEqual(
        checks.find((check) => check.name === "Entire: findings")?.url,
        "https://entire.com/gh/acme/web/trails/7/add-the-thing",
      );
      assert.strictEqual(Json.toChecksState(checks), "failing");
    });

    it("says a failing gate fails even when the CI runs could not be read", () => {
      const unread = (gates: ReadonlyArray<unknown>) =>
        decodeDetail({
          ...Fixtures.blocked,
          mergeability: {
            ...Fixtures.blocked.mergeability,
            gates,
            checks: { availability: "unavailable", runs: [] },
          },
        });
      assert.strictEqual(
        Json.toSummaryChecksState(unread(Fixtures.blocked.mergeability.gates), repo),
        "failing",
      );
      // Passing gates alone say nothing about the runs it could not read.
      assert.isUndefined(
        Json.toSummaryChecksState(unread([Fixtures.blocked.mergeability.gates[3]]), repo),
      );
    });
  });

  it("summarises checks only from a complete read, and none found as none", () => {
    assert.strictEqual(
      Json.toSummaryChecksState(decodeDetail(Fixtures.detail), "gh/acme/web"),
      "pending",
    );
    assert.isUndefined(Json.toSummaryChecksState(decodeDetail(Fixtures.gated), "gh/acme/web"));
    const empty = {
      ...Fixtures.detail,
      mergeability: {
        ...Fixtures.detail.mergeability,
        checks: { availability: "available", runs: [] },
      },
    };
    assert.isNull(Json.toSummaryChecksState(decodeDetail(empty), "gh/acme/web"));
  });

  // Mergeability is the conflict verdict alone, as GitHub's is; whether the gates let a merge
  // through is the merge action's availability, which the merge itself re-reads.
  it.each([
    [{}, "mergeable"],
    [{ mergeable: false }, "mergeable"],
    [{ mergeable: true, conflict_status: "conflicting" }, "conflicting"],
    [{ mergeable: true, conflict_status: "unknown" }, "unknown"],
    [{ mergeable: true, conflict_status: undefined }, "unknown"],
  ] as const)("reads mergeability %o as %s", (patch, expected) => {
    const detail = decodeDetail({
      ...Fixtures.detail,
      mergeability: { ...Fixtures.detail.mergeability, ...patch },
    });
    assert.strictEqual(Json.toMergeability(detail), expected);
  });

  it("puts line-anchored discussions in review threads and the rest in the conversation", () => {
    const activity = Json.toActivity({
      timeline: decodeTimeline(Fixtures.timeline),
      discussions: ["dsc_1", "dsc_2"].map((id) => decodeDiscussion(Fixtures.discussionDetails[id])),
      discussionsTruncated: false,
    });
    assert.deepStrictEqual(
      activity.comments.map((comment) => [
        comment.id,
        comment.kind,
        comment.reviewState,
        comment.canEdit,
      ]),
      [
        ["trail-approval-1", "review", "changes_requested", undefined],
        // A message is addressed within its discussion; only its author can rewrite it, which
        // the reader's login decides.
        ["dsc_1:msg_1", "issue-comment", null, undefined],
        // A finding's own text opens its review thread; the messages are replies. Entire edits
        // neither a finding's text nor a reply from here.
        ["rc_1", "review-comment", null, false],
        ["dsc_1:msg_2", "issue-comment", null, false],
        ["dsc_2:msg_3", "review-comment", null, undefined],
      ],
    );
    assert.deepStrictEqual(
      activity.reviewThreads[0]?.comments.map((comment) => [comment.id, comment.canEdit]),
      [
        ["rc_1", false],
        ["dsc_2:msg_3", undefined],
      ],
    );
    assert.deepStrictEqual(
      activity.reviewThreads.map((thread) => [
        thread.id,
        thread.path,
        thread.line,
        thread.isResolved,
      ]),
      [["dsc_2", "src/app.ts", 12, true]],
    );
    assert.deepStrictEqual(
      activity.commits.map((commit) => [commit.oid, commit.messageHeadline]),
      [[Fixtures.HEAD_SHA, "Do the thing"]],
    );
    assert.isFalse(activity.commentsTruncated);
  });

  it.each([
    ["high", "**High** · Guard the empty case"],
    ["low", "**Low** · Guard the empty case"],
    [null, "Guard the empty case"],
  ] as const)("opens a finding of severity %s with %s", (severity, body) => {
    const discussion = decodeDiscussion({
      discussion: {
        ...Fixtures.discussions.items[1],
        review_comment: {
          id: "rc_1",
          body: "Guard the empty case",
          severity,
          created_at: "2026-10-01T12:31:00.000Z",
          location: { file_path: "src/app.ts", start_line: 12 },
        },
      },
      messages: [],
    });
    const activity = Json.toActivity({
      timeline: decodeTimeline(Fixtures.timeline),
      discussions: [discussion],
      discussionsTruncated: false,
    });
    assert.strictEqual(activity.reviewThreads[0]?.comments[0]?.body, body);
  });

  it("treats an open trail that isn't ready for review as a draft", () => {
    const cases: ReadonlyArray<[string, boolean | undefined, boolean]> = [
      ["draft", undefined, true],
      ["open", false, true],
      ["open", true, false],
      ["open", undefined, false],
      ["merged", false, false],
      ["closed", false, false],
    ];
    for (const [status, ready, draft] of cases) {
      assert.strictEqual(
        Json.isDraftTrail({ status, ...(ready === undefined ? {} : { ready_for_review: ready }) }),
        draft,
        `${status}/${String(ready)}`,
      );
    }
  });
});
