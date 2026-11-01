import { assert, describe, it } from "@effect/vitest";
import type { PullRequestProviderApi } from "@t3tools/source-control-core/server/PullRequestProvider";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as EntirePullRequestProvider from "./EntirePullRequestProvider.ts";
import * as Fixtures from "./entireFixtures.ts";
import {
  Answer,
  fakeEntire,
  PROJECT_CELL_ORIGIN,
  PROJECT_TRAILS,
  TRAIL_COLLECTION,
} from "./entireTestServer.ts";

const target = { cwd: "/repo", host: "entire.io", repository: "gh/acme/web", number: 7 };

describe("EntirePullRequestProvider", () => {
  it.effect("fails what Entire does not support without a request", () => {
    const server = fakeEntire({});
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      for (const result of [
        yield* provider
          .setReaction({ ...target, content: "rocket", reacted: true })
          .pipe(Effect.flip),
        yield* provider.listReviewerCandidates(target).pipe(Effect.flip),
        yield* provider
          .setReviewerRequest({ ...target, reviewers: [], requested: true })
          .pipe(Effect.flip),
      ])
        assert.strictEqual(result.reason, "failed");
      assert.deepStrictEqual(server.sent, []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("merges against the head Entire reports at the moment of the merge", () => {
    const heads = ["aaaa", Fixtures.HEAD_SHA];
    const server = fakeEntire({
      // The page loaded an older head; the provider reads the trail again before merging.
      "GET /trails/7": () => ({ ...Fixtures.detail, head_sha: heads.shift() ?? null }),
      "POST /trails/7/merge": { ok: true, mergeCommitSha: "m", branchDeleted: true },
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      yield* provider.getChangeRequest(target);
      yield* provider.runAction({ ...target, action: "merge" });
      assert.deepStrictEqual(server.writes(), ["POST /trails/7/merge"]);
      assert.deepStrictEqual(server.sent.at(-1)?.body, { expectedHeadSha: Fixtures.HEAD_SHA });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("refuses a squash merge and a merge Entire declines", () => {
    const server = fakeEntire({
      "GET /trails/7": Fixtures.detail,
      "POST /trails/7/merge": { ok: false },
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const squash = yield* provider
        .runAction({ ...target, action: "merge", mergeMethod: "squash" })
        .pipe(Effect.flip);
      assert.strictEqual(squash.reason, "failed");
      assert.deepStrictEqual(server.writes(), []);
      yield* provider.runAction({ ...target, action: "merge" }).pipe(Effect.flip);
      assert.deepStrictEqual(server.writes(), ["POST /trails/7/merge"]);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("approves, and leaves requesting changes to entire.com", () => {
    const server = fakeEntire({ "POST /trails/7/approvals": { ok: true } });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const refused = yield* provider
        .submitReview({ ...target, verdict: "request-changes", body: "Rename it", comments: [] })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "failed");
      assert.deepStrictEqual(server.writes(), []);

      yield* provider.submitReview({ ...target, verdict: "approve", body: "", comments: [] });
      assert.deepStrictEqual(
        server.sent.map((request) => request.body),
        [{ event: "approve" }],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("comments, replies and resolves through the trail's discussions", () => {
    const server = fakeEntire({
      "POST /trails/7/discussions": { discussion: {}, message: {} },
      "POST /trails/7/discussions/dsc_2/messages": { message: {} },
      "PATCH /trails/7/discussions/dsc_2": { discussion: {} },
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      yield* provider.comment({ ...target, body: "Hello" });
      yield* provider.replyToThread({ ...target, threadId: "dsc_2", body: "Fixed" });
      yield* provider.setThreadResolution({ ...target, threadId: "dsc_2", resolved: true });
      const escape = yield* provider
        .replyToThread({ ...target, threadId: "../merge", body: "x" })
        .pipe(Effect.flip);
      assert.strictEqual(escape.reason, "failed");
      assert.deepStrictEqual(
        server.sent.map((request) => [`${request.method} ${request.path}`, request.body]),
        [
          ["POST /trails/7/discussions", { body: "Hello" }],
          ["POST /trails/7/discussions/dsc_2/messages", { body: "Fixed" }],
          ["PATCH /trails/7/discussions/dsc_2", { resolved: true }],
        ],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    ["ready", { status: "open", ready_for_review: true }],
    // Entire's status is open, merged or closed; a draft is an open trail not ready for review.
    ["draft", { ready_for_review: false }],
    ["close", { status: "closed" }],
    ["reopen", { status: "open" }],
  ] as const)("moves a trail to %s with a trail update", ([action, body]) => {
    const server = fakeEntire({ "PATCH /trails/7": { trail: {} } });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      yield* provider.runAction({ ...target, action });
      assert.deepStrictEqual(server.sent.at(-1)?.body, body);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect(
    "updates a trail's branch by merging its base in, and says why Entire could not",
    () => {
      const outcomes: Array<unknown> = [
        { mergeCommitSha: "f".repeat(40) },
        new Answer(409, { detail: "merge conflict must be resolved manually" }),
        new Answer(502, { detail: "storage unavailable" }),
      ];
      const server = fakeEntire({ "POST /trails/7/update-branch": () => outcomes.shift() });
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        const update = provider.runAction({
          ...target,
          action: "update-branch",
          updateMethod: "merge",
        });
        yield* update;
        assert.deepStrictEqual(server.sent.at(-1)?.body, undefined);
        assert.include((yield* Effect.flip(update)).detail, "resolved");
        assert.include((yield* Effect.flip(update)).detail, "storage unavailable");
        const rebase = yield* provider
          .runAction({ ...target, action: "update-branch", updateMethod: "rebase" })
          .pipe(Effect.flip);
        assert.include(rebase.detail, "merging its base in");
        assert.strictEqual(server.writes().length, 3);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect("renames a trail, and refuses a description it can't route to a project trail", () => {
    const server = fakeEntire({
      "PATCH /trails/7": { trail: {} },
      "GET /trails/7": {
        ...Fixtures.detail,
        body_document: { text_snapshot: "Old", etag: 'W/"d1"' },
      },
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      yield* provider.updateChangeRequest!({ ...target, title: "Add the other thing" });
      const error = yield* provider.updateChangeRequest!({
        ...target,
        title: "Renamed",
        body: "New",
      }).pipe(Effect.flip);
      assert.strictEqual(
        error.detail,
        "T3 Code couldn't reach this change's project trail to save the description. Try again, or edit it on entire.com.",
      );
      // Neither the description nor the title was written.
      assert.deepStrictEqual(
        server.sent
          .filter((request) => request.method !== "GET")
          .map((request) => [`${request.method} ${request.path}`, request.body]),
        [["PATCH /trails/7", { title: "Add the other thing" }]],
      );
    }).pipe(Effect.provide(server.layer));
  });

  describe("a change's project trail", () => {
    const trailPath = `${PROJECT_TRAILS}/01J0PARENT0000000000000000`;
    const parent = {
      number: 1070,
      url: "https://entire.com/gh/acme/-/trails/1070",
      path: trailPath,
      primary_processing_cell: "aws-eu-central-1",
      jurisdiction: "eu",
    };
    const link = `Part of trail [#1070](${parent.url}) on Entire.`;
    const change = {
      ...Fixtures.detail,
      parent,
      body_document: { text_snapshot: "The copy taken at linking", etag: 'W/"c1"' },
    };

    it.effect("shows the project trail's description, read from its project's cell", () => {
      const server = fakeEntire({
        "GET /trails/7": change,
        [`GET ${trailPath}`]: { bodyDocument: { text_snapshot: "The intent, as edited" } },
      });
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        const detail = yield* provider.getChangeRequest(target);
        assert.strictEqual(detail.body, `${link}\n\nThe intent, as edited`);
        assert.strictEqual(
          server.sent.find((request) => request.path === trailPath)?.origin,
          PROJECT_CELL_ORIGIN,
        );
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("falls back to the change's copy when the project trail can't be read", () => {
      const server = fakeEntire({ "GET /trails/7": change });
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        const detail = yield* provider.getChangeRequest(target);
        assert.strictEqual(detail.body, `${link}\n\nThe copy taken at linking`);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("saves a description edit to the project trail, against the version read", () => {
      const server = fakeEntire(
        {
          "GET /trails/7": change,
          [`GET ${trailPath}`]: { bodyDocument: { text_snapshot: "Old intent" } },
          [`PATCH ${trailPath}`]: {},
        },
        { etag: 'W/"p1"' },
      );
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        yield* provider.updateChangeRequest!({ ...target, body: `${link}\n\nNew intent` });
        assert.deepStrictEqual(server.writes(), [`PATCH ${trailPath}`]);
        const write = server.sent.at(-1);
        assert.deepStrictEqual(write?.body, { body: "New intent" });
        assert.strictEqual(write?.headers["if-match"], 'W/"p1"');
        assert.strictEqual(write?.origin, PROJECT_CELL_ORIGIN);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("saves over a project trail description it renders in full", () => {
      const server = fakeEntire(
        {
          "GET /trails/7": change,
          [`GET ${trailPath}`]: {
            bodyDocument: {
              text_snapshot: "Old intent",
              content_json: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: "Old intent",
                        marks: [{ type: "link", attrs: { href: "https://entire.io/docs" } }],
                      },
                    ],
                  },
                ],
              },
            },
          },
          [`PATCH ${trailPath}`]: {},
        },
        { etag: 'W/"p1"' },
      );
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        yield* provider.updateChangeRequest!({ ...target, body: `${link}\n\nNew intent` });
        assert.deepStrictEqual(server.writes(), [`PATCH ${trailPath}`]);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect.each([
      [
        "a link it can't show",
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "click",
              marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
            },
          ],
        },
        "links that aren't web or mail links",
      ],
      [
        "content it can't show",
        { type: "image", attrs: { src: "https://entire.io/a.png" } },
        "unsupported content: image",
      ],
    ] as const)("refuses to save over a description with %s", ([, block, lost]) => {
      const server = fakeEntire(
        {
          "GET /trails/7": change,
          [`GET ${trailPath}`]: {
            bodyDocument: {
              text_snapshot: "click",
              content_json: {
                type: "doc",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Intro" }] }, block],
              },
            },
          },
          [`PATCH ${trailPath}`]: {},
        },
        { etag: 'W/"p1"' },
      );
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        // Shown as far as T3 Code can, but not saved over.
        assert.include((yield* provider.getChangeRequest(target)).body, "Intro");
        const error = yield* provider.updateChangeRequest!({
          ...target,
          body: `${link}\n\nNew intent`,
        }).pipe(Effect.flip);
        assert.strictEqual(
          error.detail,
          `This description has formatting T3 Code can't preserve; edit it on entire.com (${lost}).`,
        );
        assert.deepStrictEqual(server.writes(), []);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("asks for a refresh when the project trail changed since it was read", () => {
      const server = fakeEntire(
        {
          "GET /trails/7": change,
          [`GET ${trailPath}`]: { bodyDocument: { text_snapshot: "Old intent" } },
          [`PATCH ${trailPath}`]: new Answer(412, { title: "Precondition Failed" }),
        },
        { etag: 'W/"p1"' },
      );
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        const error = yield* provider.updateChangeRequest!({
          ...target,
          title: "Renamed",
          body: "New intent",
        }).pipe(Effect.flip);
        assert.strictEqual(
          error.detail,
          "The description changed elsewhere. Refresh and try again.",
        );
        // The title is left as it was.
        assert.deepStrictEqual(server.writes(), [`PATCH ${trailPath}`]);
      }).pipe(Effect.provide(server.layer));
    });
  });

  it.effect("refuses to rewrite formatting Entire's markdown would lose, title and all", () => {
    const server = fakeEntire({
      "GET /trails/7": {
        ...Fixtures.detail,
        body_document: { text_snapshot: "Plain", etag: 'W/"d1"' },
      },
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const error = yield* provider.updateChangeRequest!({
        ...target,
        title: "Renamed",
        body: "Now ~~struck~~",
      }).pipe(Effect.flip);
      assert.include(error.detail, "formatting T3 Code can't preserve; edit it on entire.com");
      assert.include(error.detail, "strikethrough");
      assert.deepStrictEqual(server.writes(), []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("rewrites a message by its discussion, and says when it is not the reader's", () => {
    const answers: Array<unknown> = [
      { message: {} },
      new Answer(404, { detail: "Message not found" }),
    ];
    const server = fakeEntire({
      "PATCH /trails/7/discussions/dsc_1/messages/msg_1": () => answers.shift(),
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const edit = (commentId: string) =>
        provider.updateComment!({ ...target, commentId, kind: "issue-comment", body: "Fixed" });
      yield* edit("dsc_1:msg_1");
      assert.deepStrictEqual(server.sent.at(-1)?.body, { body: "Fixed" });
      const notOwn = yield* Effect.flip(edit("dsc_1:msg_1"));
      assert.include(notOwn.detail, "your own");
      // Explaining the status keeps the reason Entire's answer gave.
      assert.strictEqual(notOwn.reason, "not-found");
      for (const id of ["msg_1", "rc_1", "dsc_1:../merge"])
        assert.strictEqual((yield* Effect.flip(edit(id))).reason, "failed");
      assert.strictEqual(server.writes().length, 2);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect.each([
    ["authored", "alice", [7]],
    ["reviewing", "bob", [7]],
    ["reviewing", "alice", []],
  ] as const)("lists %s trails for %s from the rows' people", ([involvement, viewer, numbers]) => {
    const server = fakeEntire({ "GET /trails": { items: [Fixtures.trail], next_cursor: null } });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "open",
        involvement,
        viewer,
        limit: 10,
        query: "thing",
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [...numbers],
      );
      assert.strictEqual(server.sent[0]?.query.get("status"), "draft,open");
      assert.strictEqual(server.sent[0]?.query.get("q"), "thing");
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("says a list was cut when its last page held more rows than asked for", () => {
    const server = fakeEntire({
      "GET /trails": {
        items: [7, 8, 9].map((number) => ({ ...Fixtures.trail, number })),
        next_cursor: null,
      },
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...target,
        state: "all",
        involvement: "all",
        viewer: "alice",
        limit: 2,
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [7, 8],
      );
      assert.isTrue(page.truncated);
    }).pipe(Effect.provide(server.layer));
  });

  describe("list rows' drafts where the repository has no approvals gate", () => {
    const approvals = (enabled: boolean) => ({
      gates: [
        { gateKey: "checks", gateType: "checks", scopeType: "repo", enabled: true, blocking: true },
        { gateKey: "approvals", gateType: "approvals", scopeType: "repo", enabled, blocking: true },
      ],
      gatesEnabled: true,
    });
    const LIST = {
      "GET /trails": {
        items: [
          { ...Fixtures.trail, number: 7, ready_for_review: false },
          { ...Fixtures.trail, number: 8, status: "draft", ready_for_review: false },
          { ...Fixtures.trail, number: 9, ready_for_review: true },
        ],
        next_cursor: null,
      },
    };
    const drafts = (provider: PullRequestProviderApi) =>
      provider
        .listChangeRequests({
          ...target,
          state: "open",
          involvement: "all",
          viewer: "alice",
          limit: 10,
        })
        .pipe(Effect.map((page) => page.items.map((item) => [item.number, item.isDraft])));

    it.effect.each([
      ["off", approvals(false), [false, true, false]],
      ["absent", { gates: [], gatesEnabled: true }, [false, true, false]],
      ["on", approvals(true), [true, true, false]],
    ] as const)("reads readiness as a draft only while approvals are %s", ([, gates, expected]) => {
      const server = fakeEntire({ ...LIST, "GET /trails/gates": gates });
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        const first = yield* drafts(provider);
        assert.deepStrictEqual(
          first.map(([, isDraft]) => isDraft),
          [...expected],
        );
        // The repository's gates are read once for a while, not on every list.
        yield* drafts(provider);
        assert.strictEqual(
          server.sent.filter((request) => request.path === "/trails/gates").length,
          1,
        );
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("keeps reading readiness as a draft when the gates cannot be read", () => {
      const server = fakeEntire(LIST);
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        assert.deepStrictEqual(yield* drafts(provider), [
          [7, true],
          [8, true],
          [9, false],
        ]);
      }).pipe(Effect.provide(server.layer));
    });
  });

  describe("list rows' conflict state from the owning project's trail list", () => {
    const REPO = "01J0REP0000000000000000000";
    const OTHER_REPO = "01J0REP0000000000000000001";
    const PROJECT = "01J0PR00000000000000000000";
    const coordinates = { repoId: REPO, projectId: PROJECT };
    const change = (number: number, conflictStatus: string | null, repositoryId = REPO) => ({
      id: `01J0CHANGE${number}`,
      repositoryId,
      repository: "web",
      number,
      status: "open",
      readiness: "unknown",
      mergeability:
        conflictStatus === null
          ? null
          : {
              conflict_status: conflictStatus,
              head_sha: Fixtures.HEAD_SHA,
              refreshed_at: "2026-10-02T10:00:00.000Z",
              forge_merge_block: null,
            },
    });
    const projectTrail = (changes: ReadonlyArray<unknown>) => ({
      id: "01J0TRAIL",
      number: 1070,
      phase: changes.length > 0 ? "building" : "planning",
      readiness: "unknown",
      changes,
    });
    const rows = (numbers: ReadonlyArray<number>) => ({
      "GET /trails": {
        items: numbers.map((number) => ({ ...Fixtures.trail, number })),
        next_cursor: null,
      },
    });
    const list = (provider: PullRequestProviderApi) =>
      provider
        .listChangeRequests({
          ...target,
          state: "open",
          involvement: "all",
          viewer: "alice",
          limit: 10,
        })
        .pipe(Effect.map((page) => page.items.map((item) => [item.number, item.mergeability])));

    it.effect("reads each open row's stored verdict from its change on the project list", () => {
      const server = fakeEntire(
        {
          ...rows([7, 8, 9, 10, 11, 12]),
          [`GET ${TRAIL_COLLECTION}`]: (request: { query: URLSearchParams }) =>
            request.query.get("pageToken") === "p2"
              ? { items: [projectTrail([change(10, "unknown"), change(11, null)])] }
              : {
                  items: [
                    projectTrail([
                      change(7, "clean"),
                      change(8, "conflicting"),
                      change(9, "conflicts"),
                    ]),
                    // Another repository's change 12 is not this one's.
                    projectTrail([change(12, "clean", OTHER_REPO)]),
                    projectTrail([]),
                  ],
                  nextPageToken: "p2",
                },
        },
        { coordinates },
      );
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        assert.deepStrictEqual(yield* list(provider), [
          [7, "mergeable"],
          [8, "conflicting"],
          [9, "conflicting"],
          [10, "unknown"],
          [11, "unknown"],
          [12, "unknown"],
        ]);
        const reads = server.sent.filter((request) => request.path === TRAIL_COLLECTION);
        // Entire stores verdicts only for building trails, so the list asks for those alone.
        assert.deepStrictEqual(
          reads.map((request) => Object.fromEntries(request.query)),
          [
            {
              projectId: PROJECT,
              repoId: REPO,
              status: "open",
              phase: "building",
              pageSize: "100",
            },
            {
              projectId: PROJECT,
              repoId: REPO,
              status: "open",
              phase: "building",
              pageSize: "100",
              pageToken: "p2",
            },
          ],
        );
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("keeps the verdicts of pages read before one fails", () => {
      const server = fakeEntire(
        {
          ...rows([7, 8]),
          [`GET ${TRAIL_COLLECTION}`]: (request: { query: URLSearchParams }) =>
            request.query.get("pageToken") === "p2"
              ? new Answer(503, { title: "Unavailable" })
              : { items: [projectTrail([change(7, "conflicting")])], nextPageToken: "p2" },
        },
        { coordinates },
      );
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        assert.deepStrictEqual(yield* list(provider), [
          [7, "conflicting"],
          [8, "unknown"],
        ]);
      }).pipe(Effect.provide(server.layer));
    });

    it.effect("takes the project from the rows' parent trail when the CLI names none", () => {
      const parent = { id: "01J0PARENT", number: 1070, project_id: PROJECT };
      const server = fakeEntire(
        {
          "GET /trails": {
            items: [
              { ...Fixtures.trail, number: 7, parent: null },
              { ...Fixtures.trail, number: 8, parent },
            ],
            next_cursor: null,
          },
          [`GET ${TRAIL_COLLECTION}`]: {
            items: [projectTrail([change(7, "clean"), change(8, "conflicting")])],
            nextPageToken: null,
          },
        },
        { coordinates: { repoId: REPO, projectId: null } },
      );
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        assert.deepStrictEqual(yield* list(provider), [
          [7, "mergeable"],
          [8, "conflicting"],
        ]);
        const read = server.sent.find((request) => request.path === TRAIL_COLLECTION);
        assert.strictEqual(read?.query.get("projectId"), PROJECT);
      }).pipe(Effect.provide(server.layer));
    });

    const clean = { [`GET ${TRAIL_COLLECTION}`]: { items: [projectTrail([change(7, "clean")])] } };
    const edges: ReadonlyArray<
      readonly [
        string,
        Record<string, unknown>,
        { repoId: string; projectId: string | null },
        boolean,
      ]
    > = [
      [
        "has no owning project",
        { ...rows([7]), ...clean },
        { repoId: REPO, projectId: null },
        false,
      ],
      // A public id names the repository group, not the placement the list's changes carry.
      [
        "is named by a public repo_ id",
        { ...rows([7]), ...clean },
        { repoId: `repo_${REPO}`, projectId: PROJECT },
        false,
      ],
      [
        "lists no open row",
        { "GET /trails": { items: [{ ...Fixtures.trail, status: "merged" }] }, ...clean },
        coordinates,
        false,
      ],
      ["has a project list Entire refuses", rows([7]), coordinates, true],
      [
        "has an unreadable project list",
        { ...rows([7]), [`GET ${TRAIL_COLLECTION}`]: { items: "nope" } },
        coordinates,
        true,
      ],
    ];
    it.effect.each(edges)("keeps rows unknown where the repository %s", ([, routes, ids, read]) => {
      const server = fakeEntire(routes, { coordinates: ids });
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        assert.deepStrictEqual(yield* list(provider), [[7, "unknown"]]);
        assert.strictEqual(
          server.sent.some((request) => request.path === TRAIL_COLLECTION),
          read,
        );
      }).pipe(Effect.provide(server.layer));
    });
  });

  it.effect("reads the detail with its body, checks, comparison and merge availability", () => {
    const server = fakeEntire({ "GET /trails/7": Fixtures.detail });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(target);
      assert.deepInclude(detail, {
        body: "The body",
        headSha: Fixtures.HEAD_SHA,
        mergeability: "mergeable",
        baseComparison: "behind",
        behindBy: 2,
        checksState: "pending",
      });
      assert.deepStrictEqual(detail.mergeCapabilities, {
        merge: true,
        squash: false,
        rebase: false,
      });
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("waits a while before fetching a head it could not fetch again", () => {
    let gitRuns = 0;
    const unreachable = (cwd: string) =>
      Effect.suspend(() => {
        gitRuns++;
        return Effect.fail(
          new GitCommandError({ operation: "fetch", command: "git", cwd, detail: "offline" }),
        );
      });
    const server = fakeEntire(
      { "GET /trails/7": Fixtures.detail },
      {
        git: {
          execute: ({ cwd }) => unreachable(cwd),
          fetchRemoteTrackingBranch: ({ cwd }) => unreachable(cwd),
        },
      },
    );
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      assert.strictEqual((yield* provider.getChangeRequest(target)).changedFiles, 0);
      const tried = gitRuns;
      assert.isAbove(tried, 0);
      // A detail polled while Entire's remote is unreachable fetches nothing more for a while.
      assert.strictEqual((yield* provider.getChangeRequest(target)).changedFiles, 0);
      assert.strictEqual(gitRuns, tried);
      yield* TestClock.adjust("31 seconds");
      yield* provider.getChangeRequest(target);
      assert.isAbove(gitRuns, tried);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("summarises checks and mergeability so an open trail converges between reads", () => {
    const computing = {
      ...Fixtures.gated,
      mergeability: { ...Fixtures.gated.mergeability, conflict_status: "unknown" },
    };
    const reads: Array<unknown> = [computing, Fixtures.detail];
    const server = fakeEntire({ "GET /trails/7": () => reads.shift() });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const summary = provider.getChangeRequestSummary!;
      const before = yield* summary(target);
      assert.strictEqual(before.mergeability, "unknown");
      // An incomplete read of the runs leaves the last known rollup standing.
      assert.isFalse("checksState" in before);
      const after = yield* summary(target);
      assert.deepInclude(after, {
        state: "open",
        isDraft: false,
        mergeability: "mergeable",
        checksState: "pending",
        reviewDecision: "changes-requested",
        mergedAt: null,
      });
      assert.deepStrictEqual(
        server.sent.map((request) => `${request.method} ${request.path}`),
        ["GET /trails/7", "GET /trails/7"],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reads the checks from the trail", () => {
    const server = fakeEntire({ "GET /trails/7": Fixtures.detail });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const result = yield* provider.getChangeRequestChecks!(target);
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(
        result.checks.map((check) => [check.name, check.status]),
        [
          ["build", "success"],
          ["lint", "pending"],
        ],
      );
    }).pipe(Effect.provide(server.layer));
  });

  it.effect(
    "offers Merge before the gates pass, and refuses it without a write until they do",
    () => {
      const server = fakeEntire({
        "GET /trails/7": Fixtures.gated,
        "POST /trails/7/merge": { ok: true },
      });
      return Effect.gen(function* () {
        const provider = yield* EntirePullRequestProvider.make;
        const detail = yield* provider.getChangeRequest(target);
        assert.include(detail.viewerPermissions.actions, "merge");
        assert.isTrue(detail.mergeCapabilities.merge);
        const refused = yield* provider.runAction({ ...target, action: "merge" }).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "failed");
        assert.include(refused.detail, "checks_pending");
        assert.deepStrictEqual(server.writes(), []);
      }).pipe(Effect.provide(server.layer));
    },
  );

  it.effect.each([
    [
      Fixtures.blocked,
      "Entire cannot merge this trail until its approvals, findings, checks and base_checks gates pass.",
    ],
    [
      {
        ...Fixtures.blocked,
        mergeability: {
          ...Fixtures.blocked.mergeability,
          gates: Fixtures.blocked.mergeability.gates.slice(1, 2),
        },
      },
      "Entire cannot merge this trail until its findings gate passes.",
    ],
  ] as const)("names the gates a refused merge waits on: %#", ([trail, detail]) => {
    const server = fakeEntire({ "GET /trails/7": trail });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const refused = yield* provider.runAction({ ...target, action: "merge" }).pipe(Effect.flip);
      assert.strictEqual(refused.detail, detail);
      assert.deepStrictEqual(server.writes(), []);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reads the activity from the timeline and each discussion", () => {
    const server = fakeEntire({
      "GET /trails/7/timeline": Fixtures.timeline,
      "GET /trails/7/discussions": Fixtures.discussions,
      "GET /trails/7/discussions/dsc_1": Fixtures.discussionDetails.dsc_1,
      "GET /trails/7/discussions/dsc_2": Fixtures.discussionDetails.dsc_2,
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const activity = yield* provider.getChangeRequestActivity(target);
      assert.strictEqual(activity.commentCount, 5);
      assert.strictEqual(activity.reviewThreads.length, 1);
      assert.strictEqual(activity.commits.length, 1);
    }).pipe(Effect.provide(server.layer));
  });

  it.effect("reads at most 50 discussions and says the conversation was cut", () => {
    const base = Fixtures.discussions.items[0]!;
    const ids = Array.from({ length: 51 }, (_, index) => `dsc_${index + 1}`);
    const server = fakeEntire({
      "GET /trails/7/timeline": { items: [], nextPageToken: null },
      "GET /trails/7/discussions": { items: ids.map((id) => ({ ...base, id })) },
      ...Object.fromEntries(
        ids.map((id) => [
          `GET /trails/7/discussions/${id}`,
          { discussion: { ...base, id }, messages: [] },
        ]),
      ),
    });
    return Effect.gen(function* () {
      const provider = yield* EntirePullRequestProvider.make;
      const activity = yield* provider.getChangeRequestActivity(target);
      assert.isTrue(activity.commentsTruncated);
      const reads = server.sent.filter((sent) => /^\/trails\/7\/discussions\/./u.test(sent.path));
      assert.strictEqual(reads.length, 50);
      assert.notInclude(
        reads.map((sent) => sent.path),
        "/trails/7/discussions/dsc_51",
      );
    }).pipe(Effect.provide(server.layer));
  });
});
