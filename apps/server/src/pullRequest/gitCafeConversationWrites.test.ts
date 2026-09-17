import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import { makeGitCafeConversationWrites } from "./gitCafeConversationWrites.ts";

const target = { cwd: "/work", host: "git.cafe", repository: "owner/repo", number: 7 } as const;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Call = Parameters<GitCafeCli.GitCafeCli["Service"]["api"]>[0];
const actor = {
  kind: "local",
  actorId: "author",
  handle: "author",
  displayName: "Author",
  avatarUrl: null,
} as const;
const pull = {
  id: "pull",
  number: 7,
  title: "Title",
  state: "open",
  draft: false,
  sourceBranch: "topic",
  targetBranch: "main",
  headOid: null,
  author: actor,
  createdAt: "2026-09-17T00:00:00Z",
  updatedAt: "2026-09-17T00:00:00Z",
  version: 9,
} as const;
const fixture = (respond: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const cli = {
    api: (call: Call) =>
      Effect.sync(() => {
        calls.push(call);
        return json(respond(call));
      }),
  } as unknown as GitCafeCli.GitCafeCli["Service"];
  return { calls, writes: makeGitCafeConversationWrites(cli) };
};

describe("GitCafe conversation writes", () => {
  it.effect(
    "passes markdown verbatim and uses the comment version rather than the pull version",
    () =>
      Effect.gen(function* () {
        const markdown = "# exact\n\n```ts\nconst x = 1;  \n```";
        const f = fixture((call) =>
          call.endpoint.endsWith("/detail")
            ? { id: "comment", threadId: "thread", version: 3, resolvedAt: null }
            : { id: "comment", threadId: "thread", version: 4 },
        );
        yield* f.writes.updateComment!({
          ...target,
          commentId: "comment",
          kind: "issue-comment",
          body: markdown,
        });
        expect(f.calls[1]?.body).toEqual({ body: markdown, expectedVersion: 3 });
      }),
  );

  it.effect("accepts the production PATCH receipt without capabilities", () =>
    Effect.gen(function* () {
      const f = fixture((call) => (call.method === "PATCH" ? { version: 10 } : pull));
      yield* f.writes.updateChangeRequest!({ ...target, title: "New", body: "body" });
      expect(f.calls[1]?.body).toEqual({ expectedVersion: 9, title: "New", description: "body" });
    }),
  );

  it.effect("treats an already resolved thread as an idempotent no-op without capability", () =>
    Effect.gen(function* () {
      const f = fixture(() => ({
        items: [{ id: "thread", threadId: "thread", version: 2, resolvedAt: "now" }],
        nextAfter: null,
      }));
      yield* f.writes.setThreadResolution({ ...target, threadId: "thread", resolved: true });
      expect(f.calls).toHaveLength(1);
    }),
  );

  it.effect(
    "removes only the viewer's canonical heart reaction and makes absent removal a no-op",
    () =>
      Effect.gen(function* () {
        const reactions = (viewerReactionId: string | null) => ({
          items: [
            {
              subject: { kind: "pull_request", id: "pull" },
              emoji: { kind: "unicode", value: "❤" },
              count: 1,
              viewerReactionId,
              reactors: [actor],
            },
          ],
        });
        const present = fixture((call) =>
          call.endpoint.endsWith("/reactions/") ? reactions("viewer_reaction") : pull,
        );
        yield* present.writes.setReaction({ ...target, content: "heart", reacted: false });
        expect(present.calls[2]?.endpoint.endsWith("/reactions/viewer_reaction")).toBe(true);
        expect(present.calls[2]?.method).toBe("DELETE");

        const absent = fixture((call) =>
          call.endpoint.endsWith("/reactions/") ? reactions(null) : pull,
        );
        yield* absent.writes.setReaction({ ...target, content: "heart", reacted: false });
        expect(absent.calls).toHaveLength(2);
      }),
  );

  it.effect("replaces asymmetric reviewer and label sets only after every page", () =>
    Effect.gen(function* () {
      const reviewer = (id: string) => ({
        id,
        actor: { ...actor, actorId: id, handle: id },
        handle: id,
        displayName: id,
        avatarUrl: null,
        requestedByActorId: null,
        requestedAt: "2026-09-17T00:00:00Z",
        latestReview: null,
      });
      const reviewers = fixture((call) => {
        if (call.method === "PUT") return { version: 10 };
        if (call.endpoint.includes("/reviewers"))
          return call.endpoint.includes("after=next")
            ? { kind: "reviewers", items: [reviewer("b")], nextAfter: null }
            : { kind: "reviewers", items: [reviewer("a")], nextAfter: "next" };
        return pull;
      });
      yield* reviewers.writes.setReviewerRequest({
        ...target,
        reviewers: [{ id: "a", kind: "user" }],
        requested: false,
      });
      expect(reviewers.calls.at(-1)?.body).toEqual({ expectedVersion: 9, actorIds: ["b"] });

      const labels = fixture((call) => {
        if (call.method === "PUT") return { version: 10 };
        if (call.endpoint.includes("/pulls/7/labels"))
          return call.endpoint.includes("after=next")
            ? {
                kind: "labels",
                items: [{ id: "old2", name: "old2", color: "fff", description: null }],
                nextAfter: null,
              }
            : {
                kind: "labels",
                items: [{ id: "old1", name: "old1", color: "fff", description: null }],
                nextAfter: "next",
              };
        if (call.endpoint.includes("/labels"))
          return {
            items: [{ id: "new", name: "new", color: "000", description: null }],
            nextAfter: null,
          };
        return pull;
      });
      yield* labels.writes.setLabels!({ ...target, labels: ["new"], applied: true });
      expect(labels.calls.at(-1)?.body).toEqual({
        expectedVersion: 9,
        labelIds: ["old1", "old2", "new"],
      });
    }),
  );

  it.effect("rejects cyclic pagination without replacing a partial reviewer set", () =>
    Effect.gen(function* () {
      const f = fixture((call) =>
        call.endpoint.includes("/reviewers")
          ? { kind: "reviewers", items: [], nextAfter: "same" }
          : pull,
      );
      const result = yield* Effect.result(
        f.writes.setReviewerRequest({ ...target, reviewers: [], requested: true }),
      );
      expect(result._tag).toBe("Failure");
      expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect("does not retry a stale change request conflict", () =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const cli = {
        api: (call: Call) => {
          calls.push(call);
          return call.method === "PATCH"
            ? Effect.fail(
                new GitCafeCli.GitCafeCliError({
                  command: "cafe",
                  cwd: target.cwd,
                  code: "CONFLICT",
                  status: 409,
                  detail: "stale version",
                }),
              )
            : Effect.succeed(json(pull));
        },
      } as unknown as GitCafeCli.GitCafeCli["Service"];
      const result = yield* Effect.result(
        makeGitCafeConversationWrites(cli).updateChangeRequest!({ ...target, title: "New" }),
      );
      expect(result._tag).toBe("Failure");
      expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    }),
  );
});
