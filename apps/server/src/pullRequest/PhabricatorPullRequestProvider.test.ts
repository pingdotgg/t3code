import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcess, type VcsProcessInput } from "../vcs/VcsProcess.ts";
import { make } from "./PhabricatorPullRequestProvider.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const reference = { cwd: "/repo", host: "reviews.example", repository: "differential", number: 42 };
const revision = (status = "needs-review") => ({
  id: 42,
  phid: "PHID-DREV-42",
  attachments: { reviewers: { reviewers: [{ reviewerPHID: "PHID-USER-reviewer" }] } },
  fields: {
    title: "Update feature",
    uri: "https://reviews.example/D42",
    authorPHID: "PHID-USER-author",
    status: { value: status, closed: status === "published" || status === "abandoned" },
    diffPHID: "PHID-DIFF-7",
    summary: "Description",
    testPlan: "Run tests",
    isDraft: false,
    dateCreated: 1700000000,
    dateModified: 1700000010,
  },
});
const page = (data: readonly unknown[], after: string | null = null) => ({
  data,
  cursor: { after },
});
const users = page([
  { phid: "PHID-USER-author", fields: { username: "alice", realName: "Alice" } },
  { phid: "PHID-USER-reviewer", fields: { username: "bob", realName: "Bob" } },
]);
const provider = (respond: (input: VcsProcessInput) => unknown, truncated = false) =>
  make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Path.layer,
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed('{"phabricator.uri":"https://reviews.example/"}'),
        }),
        Layer.mock(VcsProcess)({
          run: (input) =>
            Effect.succeed({
              stdout: encode(respond(input)),
              stderr: "",
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdoutTruncated: truncated,
              stderrTruncated: false,
            }),
        }),
      ),
    ),
  );

it.effect.each([
  ["needs-review", "open"],
  ["accepted", "open"],
  ["published", "merged"],
  ["abandoned", "closed"],
])("tracks Differential %s as %s", ([status, state]) =>
  Effect.gen(function* () {
    const api = yield* provider(() => ({
      error: null,
      errorMessage: null,
      response: page([revision(status)]),
    }));
    const summary = yield* api.getChangeRequestSummary!(reference);
    expect(summary).toMatchObject({
      number: 42,
      state,
      url: "https://reviews.example/D42",
      headBranch: "D42",
    });
    expect(summary.updatedAt).toBe("2023-11-14T22:13:30.000Z");
  }),
);

it.effect("reads revision details and resolves author and reviewer identities", () =>
  Effect.gen(function* () {
    const api = yield* provider((input) => ({
      error: null,
      errorMessage: null,
      response: input.operation === "user.search" ? users : page([revision()]),
    }));
    const detail = yield* api.getChangeRequest(reference);
    expect(detail.author?.login).toBe("alice");
    expect(detail.reviewers.map((actor) => actor.login)).toEqual(["bob"]);
    expect(detail.reviewRequestLogins).toEqual(["bob"]);
    expect(detail.body).toBe("Description\n\nRun tests");
    expect(detail.viewerPermissions.actions).toEqual([]);
  }),
);

it.effect("paginates host revisions and sends authenticated involvement constraints", () =>
  Effect.gen(function* () {
    const requests: VcsProcessInput[] = [];
    const api = yield* provider((input) => {
      requests.push(input);
      const response =
        input.operation === "user.whoami"
          ? { userName: "bob", phid: "PHID-USER-reviewer" }
          : input.operation === "user.search"
            ? users
            : requests.filter((request) => request.operation === "differential.revision.search")
                  .length === 1
              ? page([revision()], "next")
              : page([{ ...revision(), id: 43 }]);
      return { error: null, errorMessage: null, response };
    });
    const result = yield* api.listChangeRequests({
      ...reference,
      state: "open",
      involvement: "reviewing",
      viewer: "bob",
      limit: 2,
    });
    expect(result.items.map((item) => item.number)).toEqual([42, 43]);
    expect(result.continues).toBe(false);
    const search = requests.filter(
      (request) => request.operation === "differential.revision.search",
    );
    const decode = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
    expect(yield* decode(search[0]!.stdin!)).toMatchObject({
      constraints: { reviewerPHIDs: ["PHID-USER-reviewer"], statuses: ["open()"] },
    });
    expect(yield* decode(search[1]!.stdin!)).toMatchObject({ after: "next", limit: 1 });
    expect(search[0]!.args).toEqual([
      "--conduit-uri",
      "https://reviews.example/",
      "call-conduit",
      "--",
      "differential.revision.search",
    ]);
  }),
);

it.effect("fetches the active diff rather than treating a revision ID as a diff ID", () =>
  Effect.gen(function* () {
    const api = yield* provider((input) => {
      const response =
        input.operation === "differential.revision.search"
          ? page([revision()])
          : input.operation === "differential.diff.search"
            ? page([{ id: 7, fields: { refs: [] } }])
            : "diff --git a/file b/file\n";
      if (input.operation === "differential.getrawdiff") expect(input.stdin).toBe('{"diffID":7}');
      return { error: null, errorMessage: null, response };
    });
    expect(yield* api.getDiff(reference)).toEqual({
      patch: "diff --git a/file b/file\n",
      truncated: false,
      nextCursor: null,
    });
  }),
);

it.effect.each(["ERR-INVALID-AUTH", "ERR-NOT-AUTHENTICATED"])(
  "classifies %s as unauthenticated",
  (error) =>
    Effect.gen(function* () {
      const api = yield* provider(() => ({ error, errorMessage: "Sign in", response: null }));
      expect(yield* api.getViewer(reference).pipe(Effect.flip)).toMatchObject({
        reason: "unauthenticated",
      });
    }),
);

it.effect.each(["invalid", "missing", "truncated"])("rejects %s revision responses", (variant) =>
  Effect.gen(function* () {
    const api = yield* provider(
      () => ({
        error: null,
        errorMessage: null,
        response: variant === "invalid" ? page([{ id: 42 }]) : page([]),
      }),
      variant === "truncated",
    );
    expect(yield* api.getChangeRequestSummary!(reference).pipe(Effect.flip)).toMatchObject({
      reason: "failed",
    });
  }),
);
