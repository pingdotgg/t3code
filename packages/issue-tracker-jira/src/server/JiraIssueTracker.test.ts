import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import { SourceControlHost } from "@t3tools/source-control-core/server/SourceControlHost";
import { make, parseScope } from "./JiraIssueTracker.ts";

const issue = {
  id: "123",
  key: "DEMO-1",
  summary: "Fix login",
  status: { name: "Open", statusCategory: { key: "new" } },
  created: "2026-10-01T00:00:00.000Z",
  updated: "2026-10-02T00:00:00.000Z",
  description: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Example" }] }],
  },
};
const target = { cwd: "/work", host: "demo.atlassian.net", scope: "DEMO", key: "DEMO-1" };

it.effect(
  "decodes native flattened reads and paginated searches and preserves comment audiences",
  () => {
    const calls: ReadonlyArray<string>[] = [];
    return Effect.gen(function* () {
      const api = yield* make;
      const page = yield* api.listIssues({
        ...target,
        viewer: "a",
        involvement: "all",
        state: "open",
        limit: 20,
      });
      assert.strictEqual(page.items[0]?.title, "Fix login");
      assert.strictEqual(page.nextCursor, "next-issues");
      const detail = yield* api.getIssue(target);
      assert.strictEqual(detail.body, "Example");
      assert.deepStrictEqual(
        detail.comments.map((c) => c.visibility),
        ["public", "internal", "restricted"],
      );
      assert.strictEqual(detail.commentsCursor, "next-comments");
      yield* api.comment!({ ...target, body: "Team only", visibility: "internal" });
      assert.ok(calls.at(-1)?.includes("--internal"));
      yield* api.comment!({ ...target, body: "Customer reply", visibility: "public" });
      assert.ok(!calls.at(-1)?.includes("--internal"));
      const beforeRefusal = calls.length;
      yield* Effect.flip(api.comment!({ ...target, key: "OTHER-1", body: "Wrong project" }));
      assert.strictEqual(calls.length, beforeRefusal);
      assert.ok(calls.every((args) => !args.includes("api")));
      assert.deepStrictEqual(parseScope("Demo.atlassian.net/demo"), {
        host: "demo.atlassian.net",
        scope: "DEMO",
      });
    }).pipe(
      Effect.provideService(
        SourceControlHost,
        SourceControlHost.of({
          process: {
            run: (input) => {
              calls.push(input.args);
              const data =
                input.operation === "listIssues"
                  ? {
                      data: { issues: [issue] },
                      pageInfo: { hasNextPage: true, nextCursor: "next-issues" },
                    }
                  : input.operation === "getIssue"
                    ? { data: [issue] }
                    : input.operation === "comments"
                      ? {
                          data: [
                            { id: "a", created: issue.created, body: "Public", jsdPublic: true },
                            { id: "b", created: issue.created, body: "Internal", jsdPublic: false },
                            {
                              id: "c",
                              created: issue.created,
                              body: "Restricted",
                              visibility: { type: "role", value: "Support" },
                            },
                          ],
                          pageInfo: { hasNextPage: true, nextCursor: "next-comments" },
                        }
                      : { data: {} };
              return Effect.succeed({
                exitCode: ExitCode(0),
                stdout: JSON.stringify(data),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
          },
          settings: {} as never,
          git: {} as never,
        }),
      ),
    );
  },
);
