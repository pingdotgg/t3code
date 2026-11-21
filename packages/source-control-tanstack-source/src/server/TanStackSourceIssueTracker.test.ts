import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as TanStackSourceApi from "./TanStackSourceApi.ts";
import * as TanStackSourceIssueTracker from "./TanStackSourceIssueTracker.ts";

const target = { cwd: "/repo", host: "source.tanstack.com", scope: "TanStack/ai" };

function withApi(routes: Readonly<Record<string, unknown>>) {
  const paths: Array<string> = [];
  const request = (input: TanStackSourceApi.TanStackSourceApiRequest) => {
    paths.push(input.path);
    const body = routes[input.path];
    return body === undefined
      ? Effect.die(`unexpected ${input.path}`)
      : Effect.succeed(JSON.stringify(body));
  };
  const api = TanStackSourceApi.TanStackSourceApi.of({
    request,
    response: (input) =>
      request(input).pipe(Effect.map((text) => ({ status: 200, headers: {}, text }))),
  });
  return {
    paths,
    tracker: TanStackSourceIssueTracker.make.pipe(
      Effect.provideService(TanStackSourceApi.TanStackSourceApi, api),
    ),
  };
}

const row = (number: number, state: string, createdAt: number) => ({
  number,
  title: `Issue ${number}`,
  state,
  author: "alice",
  labels: ["bug"],
  assignees: ["bob"],
  comments: 1,
  createdAt,
});

describe("TanStackSourceIssueTracker", () => {
  it.effect("lists open and closed issues together, newest first, under one cursor each", () => {
    const { tracker, paths } = withApi({
      "/repos/TanStack/ai/issues?state=open": { items: [row(3, "open", 30)], next: "o2" },
      "/repos/TanStack/ai/issues?state=closed": { items: [row(4, "closed", 40)], next: null },
      "/repos/TanStack/ai/issues?state=open&cursor=o2": {
        items: [row(1, "open", 10)],
        next: null,
      },
    });
    return Effect.gen(function* () {
      const issues = yield* tracker;
      const first = yield* issues.listIssues({
        ...target,
        involvement: "all",
        state: "all",
        limit: 50,
        sort: "created",
      });
      assert.deepStrictEqual(
        first.items.map((issue) => [issue.key, issue.state.category]),
        [
          ["4", "closed"],
          ["3", "open"],
        ],
      );
      assert.strictEqual(first.items[0]?.url, "https://source.tanstack.com/@TanStack/ai/issues/4");
      assert.isNotNull(first.nextCursor);
      const second = yield* issues.listIssues({
        ...target,
        involvement: "all",
        state: "all",
        limit: 50,
        sort: "created",
        cursor: first.nextCursor!,
      });
      assert.deepStrictEqual(
        second.items.map((issue) => issue.key),
        ["1"],
      );
      assert.isNull(second.nextCursor);
      // The closed listing had ended, so it is not read again.
      assert.strictEqual(paths.filter((path) => path.includes("state=closed")).length, 1);
    });
  });

  it.effect("reads comments, events and the pull requests that fix it, hiding held entries", () => {
    const { tracker } = withApi({
      "/user": { username: "alice" },
      "/repos/TanStack/ai/issues/2219": {
        ...row(2219, "open", 1_000),
        kind: "issue",
        body: "Spec changed.",
        assignees: [{ username: "bob", note: null }],
        timeline: [
          { event: "labeled", actor: "alice", at: 2_000 },
          { event: "linked_from", actor: "bob", at: 3_000 },
          { id: 7, comment: "On it.", author: "bob", at: 4_000, moderation: "visible" },
          { id: 8, comment: null, author: "spam", at: 5_000, moderation: "quarantined" },
        ],
        next: null,
        fixedBy: [{ number: 2221, title: "fix(ai-mcp): follow the spec", state: "open" }],
      },
    });
    return Effect.gen(function* () {
      const issues = yield* tracker;
      const issue = yield* issues.getIssue({ ...target, key: "2219" });
      assert.strictEqual(issue.body, "Spec changed.");
      assert.strictEqual(issue.viewer, "alice");
      assert.deepStrictEqual(
        issue.assignees.map((actor) => actor.login),
        ["bob"],
      );
      assert.deepStrictEqual(
        issue.events.map((event) => event.kind),
        ["labeled", "referenced"],
      );
      assert.deepStrictEqual(
        issue.comments.map((comment) => [comment.id, comment.body]),
        [["7", "On it."]],
      );
      assert.strictEqual(issue.updatedAt, "1970-01-01T00:00:05.000Z");
      assert.deepStrictEqual(issue.linkedPullRequests, [
        {
          repository: "TanStack/ai",
          number: 2221,
          title: "fix(ai-mcp): follow the spec",
          url: "https://source.tanstack.com/@TanStack/ai/pull/2221",
          state: "open",
          isDraft: false,
          closesIssue: true,
        },
      ]);
    });
  });
});
