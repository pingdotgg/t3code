import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as GitCafeCli from "../sourceControl/GitCafeCli.ts";
import { GitCafeCliError } from "../sourceControl/GitCafeCli.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import { makeGitCafeReviewWrites } from "./gitCafeReviewWrites.ts";

const head = "1".repeat(40);
const base = "2".repeat(40);
const moved = "3".repeat(40);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Call = Parameters<GitCafeCli.GitCafeCli["Service"]["api"]>[0];
type Submit = Parameters<PullRequestProviderApi["submitReview"]>[0];
const input = (changes: Partial<Submit> = {}): Submit => ({
  cwd: "/work",
  host: "git.cafe",
  repository: "owner/repo",
  number: 7,
  reviewRevision: { version: 4, headOid: head, baseOid: base },
  requestId: "review-1",
  verdict: "comment",
  body: "Summary",
  comments: [],
  ...changes,
});
const line = (body = "Line note") => ({
  path: "new.ts",
  oldPath: "old.ts",
  position: { kind: "deleted" as const, oldLine: 5 },
  body,
});
const failure = (status: number | null, detail = "failed") =>
  new GitCafeCliError({ command: "cafe", cwd: "/work", code: "COMMAND_FAILED", status, detail });

function fixture(respond: (call: Call, index: number) => unknown | GitCafeCliError) {
  const calls: Call[] = [];
  const service = {
    api: (call: Call) => {
      const index = calls.push(call) - 1;
      const result = respond(call, index);
      return Schema.is(GitCafeCliError)(result)
        ? Effect.fail(result)
        : Effect.succeed(json(result));
    },
  } as unknown as GitCafeCli.GitCafeCli["Service"];
  return { calls, writes: makeGitCafeReviewWrites(service) };
}
const identity = (actorId = "act_one") => ({ actorId });
const revision = (changes: Record<string, unknown> = {}) => ({
  version: 4,
  headOid: head,
  observedBaseOid: base,
  ...changes,
});
const savedDraft = (version = 0, changes: Record<string, unknown> = {}) => ({
  id: "draft_one",
  version,
  verdict: "comment",
  body: "Summary",
  commitOid: head,
  baseOid: base,
  pullVersion: 4,
  ...changes,
});

describe("GitCafe review writes", () => {
  it.effect("rejects anything except the exact reviewed head and pull version", () =>
    Effect.gen(function* () {
      for (const changed of [{ version: 5 }, { headOid: moved }]) {
        const f = fixture((call) =>
          call.endpoint === "/auth/principal" ? identity() : revision(changed),
        );
        const result = yield* Effect.result(f.writes.submitReview(input()));
        expect(result._tag).toBe("Failure");
        expect(f.calls.some((call) => call.method === "POST")).toBe(false);
      }
    }),
  );

  it.effect("does not claim an unrelated or multiline-prefix draft", () =>
    Effect.gen(function* () {
      const unrelated = fixture((call) => {
        if (call.endpoint === "/auth/principal") return identity();
        if (call.endpoint.endsWith("/review-draft/"))
          return { draft: { ...savedDraft(), stale: false, comments: [] } };
        return revision();
      });
      expect(
        (yield* Effect.result(unrelated.writes.submitReview(input({ comments: [line()] }))))._tag,
      ).toBe("Failure");

      let reads = 0;
      const range = fixture((call) => {
        if (call.endpoint === "/auth/principal") return identity();
        if (call.endpoint.endsWith("/review-draft/") && call.method === undefined) {
          reads++;
          return reads === 1
            ? { draft: null }
            : {
                draft: {
                  ...savedDraft(),
                  stale: false,
                  comments: [
                    {
                      id: "c1",
                      body: "Line note",
                      path: "old.ts",
                      line: 5,
                      side: "left",
                      commitOid: base,
                      startLine: 4,
                      startSide: "left",
                    },
                  ],
                },
              };
        }
        if (call.method === "PUT") return savedDraft();
        if (call.endpoint.endsWith("/comments")) return failure(409);
        return revision();
      });
      yield* Effect.result(range.writes.submitReview(input({ comments: [line()] })));
      const retried = yield* Effect.result(
        range.writes.submitReview(input({ comments: [line()] })),
      );
      expect(retried._tag).toBe("Failure");
      expect(range.calls.filter((call) => call.endpoint.endsWith("/comments"))).toHaveLength(1);
    }),
  );

  it.effect("advances draft versions sequentially and uses authoritative left anchors", () =>
    Effect.gen(function* () {
      const f = fixture((call) => {
        if (call.endpoint === "/auth/principal") return identity();
        if (call.endpoint.endsWith("/review-draft/") && call.method === undefined)
          return { draft: null };
        if (call.method === "PUT") return savedDraft(0, { baseOid: moved });
        if (call.endpoint.endsWith("/comments")) {
          const body = call.body as { expected: { version: number }; body: string };
          return {
            draft: { id: "draft_one", version: body.expected.version + 1 },
            comment: { id: `c${body.expected.version}`, ...body },
          };
        }
        if (call.endpoint.endsWith("/reviews")) return { id: "review" };
        return revision({ observedBaseOid: moved });
      });
      yield* f.writes.submitReview(input({ comments: [line("one"), line("two")] }));
      const posts = f.calls.filter((call) => call.endpoint.endsWith("/comments"));
      expect(f.calls.find((call) => call.method === "PUT")?.body).toMatchObject({ baseOid: moved });
      expect(
        posts.map((call) => (call.body as { expected: { version: number } }).expected.version),
      ).toEqual([0, 1]);
      expect(posts[0]?.body).toMatchObject({
        path: "old.ts",
        side: "left",
        commitOid: base,
        startLine: null,
        startSide: null,
      });
      expect(f.calls.at(-1)?.body).toMatchObject({ draft: { id: "draft_one", version: 2 } });
    }),
  );

  it.effect("submits a verdict without creating an inline draft", () =>
    Effect.gen(function* () {
      const f = fixture((call) =>
        call.endpoint === "/auth/principal"
          ? identity()
          : call.endpoint.endsWith("/reviews")
            ? { id: "review" }
            : revision(),
      );
      yield* f.writes.submitReview(input({ verdict: "approve", body: "" }));
      expect(f.calls.some((call) => call.endpoint.includes("review-draft"))).toBe(false);
      expect(f.calls.at(-1)?.body).toEqual({
        verdict: "approve",
        commitOid: head,
        expectedVersion: 4,
        requestId: "review-1",
      });
    }),
  );

  it.effect("replays a lost final response before checking a moved head", () =>
    Effect.gen(function* () {
      let finals = 0;
      const finalBodies: unknown[] = [];
      const f = fixture((call) => {
        if (call.endpoint === "/auth/principal") return identity();
        if (call.endpoint.endsWith("/reviews")) {
          finals++;
          finalBodies.push(call.body);
          return finals === 1 ? failure(500) : { id: "review" };
        }
        return revision(finals > 0 ? { version: 5, headOid: moved } : {});
      });
      expect((yield* Effect.result(f.writes.submitReview(input())))._tag).toBe("Failure");
      yield* f.writes.submitReview(input());
      expect(
        f.calls.filter((call) => call.endpoint.endsWith("/pulls/7") && call.method === undefined),
      ).toHaveLength(1);
      expect(finals).toBe(2);
      expect(finalBodies[1]).toEqual(finalBodies[0]);
    }),
  );

  it.effect("does not duplicate after an ambiguous draft comment failure", () =>
    Effect.gen(function* () {
      let draftReads = 0;
      const f = fixture((call) => {
        if (call.endpoint === "/auth/principal") return identity();
        if (call.endpoint.endsWith("/review-draft/") && call.method === undefined) {
          draftReads++;
          return draftReads === 1
            ? { draft: null }
            : {
                draft: {
                  ...savedDraft(1),
                  stale: false,
                  comments: [
                    {
                      id: "c1",
                      body: "Line note",
                      path: "old.ts",
                      line: 5,
                      side: "left",
                      commitOid: base,
                      startLine: null,
                      startSide: null,
                    },
                  ],
                },
              };
        }
        if (call.method === "PUT") return savedDraft();
        if (call.endpoint.endsWith("/comments")) return failure(503);
        return revision();
      });
      yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
      const retry = yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
      expect(retry._tag).toBe("Failure");
      expect(f.calls.filter((call) => call.endpoint.endsWith("/comments"))).toHaveLength(1);
    }),
  );

  it.effect("does not claim an identical unowned draft after an unknown creation response", () =>
    Effect.gen(function* () {
      let reads = 0;
      const f = fixture((call) => {
        if (call.endpoint === "/auth/principal") return identity();
        if (call.endpoint.endsWith("/review-draft/") && call.method === undefined) {
          reads++;
          return reads === 1
            ? { draft: null }
            : { draft: { ...savedDraft(), stale: false, comments: [] } };
        }
        if (call.method === "PUT") return { unexpected: true };
        return revision();
      });
      yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
      const retry = yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
      expect(retry._tag).toBe("Failure");
      expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
      expect(f.calls.filter((call) => call.endpoint.endsWith("/comments"))).toHaveLength(0);
      expect(f.calls.filter((call) => call.endpoint.endsWith("/reviews"))).toHaveLength(0);
    }),
  );

  it.effect("does not recreate a draft while an unknown creation remains absent", () =>
    Effect.gen(function* () {
      const f = fixture((call) => {
        if (call.endpoint === "/auth/principal") return identity();
        if (call.endpoint.endsWith("/review-draft/") && call.method === undefined)
          return { draft: null };
        if (call.method === "PUT") return { unexpected: true };
        return revision();
      });
      yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
      const retry = yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
      expect(retry._tag).toBe("Failure");
      if (retry._tag === "Failure") expect(retry.failure.detail).toContain("not in flight");
      expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    }),
  );

  it.effect(
    "rejects reuse with different input and an account switch without losing the attempt",
    () =>
      Effect.gen(function* () {
        let actor = "act_one";
        let draftReads = 0;
        const f = fixture((call) => {
          if (call.endpoint === "/auth/principal") return identity(actor);
          if (call.endpoint.endsWith("/review-draft/") && call.method === undefined) {
            draftReads++;
            return draftReads === 1
              ? { draft: null }
              : { draft: { ...savedDraft(), stale: false, comments: [] } };
          }
          if (call.method === "PUT") return savedDraft();
          if (call.endpoint.endsWith("/comments")) return failure(409);
          return revision();
        });
        yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
        const changed = yield* Effect.result(
          f.writes.submitReview(input({ comments: [line("different")] })),
        );
        expect(changed._tag).toBe("Failure");
        actor = "act_two";
        const other = yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
        expect(other._tag).toBe("Failure");
        actor = "act_one";
        const original = yield* Effect.result(f.writes.submitReview(input({ comments: [line()] })));
        expect(original._tag).toBe("Failure");
        expect(f.calls.filter((call) => call.endpoint.endsWith("/comments"))).toHaveLength(2);
      }),
  );

  it.effect("keeps a summary-only attempt bound to its first account", () =>
    Effect.gen(function* () {
      let actor = "act_one";
      const f = fixture((call) => {
        if (call.endpoint === "/auth/principal") return identity(actor);
        if (call.endpoint.endsWith("/reviews")) return failure(500);
        return revision();
      });
      yield* Effect.result(f.writes.submitReview(input()));
      actor = "act_two";
      const switched = yield* Effect.result(f.writes.submitReview(input()));
      expect(switched._tag).toBe("Failure");
      expect(f.calls.filter((call) => call.endpoint.endsWith("/reviews"))).toHaveLength(1);
      actor = "act_one";
      yield* Effect.result(f.writes.submitReview(input()));
      expect(f.calls.filter((call) => call.endpoint.endsWith("/reviews"))).toHaveLength(2);
    }),
  );
});
