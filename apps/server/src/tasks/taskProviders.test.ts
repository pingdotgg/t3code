import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProjectId, type TaskSource } from "@t3tools/contracts";
import {
  resolveTaskReference,
  runTaskProvider,
  taskEditableFields,
  type TaskTransport,
} from "./taskProviders.ts";

const github: TaskSource = {
  provider: "github",
  baseUrl: "https://github.com",
  scope: "team/repo",
};
const linear: TaskSource = { provider: "linear", baseUrl: "https://linear.app", scope: "team-id" };
const projectId = ProjectId.make("project");
describe("task provider boundary", () => {
  it.effect(
    "keeps usable GitHub project items and pagination when a page also contains PRs or inaccessible items",
    () =>
      Effect.gen(function* () {
        const result = yield* runTaskProvider(
          github,
          { projectId, action: "items", id: "project-id" },
          () =>
            Effect.succeed({
              data: {
                node: {
                  url: "https://github.com/orgs/team/projects/1",
                  items: {
                    nodes: [
                      { id: "pr", content: {} },
                      { id: "private", content: null },
                      {
                        id: "issue",
                        content: {
                          number: 1,
                          title: "Fix bug",
                          body: "Details",
                          url: "https://github.com/team/repo/issues/1",
                          state: "OPEN",
                        },
                      },
                      { id: "draft", content: { title: "Explore solution", body: "Draft" } },
                    ],
                    pageInfo: { hasNextPage: true, endCursor: "next-page" },
                  },
                },
              },
            }),
        );
        expect(result.tasks.map((task) => task.title)).toEqual(["Fix bug", "Explore solution"]);
        expect(result.nextCursor).toBe("next-page");
      }),
  );
  it("resolves configured issue URLs, rejecting cross-origin or cross-repository URLs", () => {
    expect(resolveTaskReference(github, "https://github.com/team/repo/issues/42")).toBe("42");
    expect(resolveTaskReference(linear, "https://linear.app/team/issue/ABC-42/title")).toBe(
      "ABC-42",
    );
    expect(() => resolveTaskReference(github, "https://github.com/other/repo/issues/42")).toThrow();
    expect(() =>
      resolveTaskReference(github, "https://github.com.evil.test/team/repo/issues/42"),
    ).toThrow();
  });
  it("does not advertise priority editing for GitHub", () => {
    expect(taskEditableFields("github")).not.toContain("priority");
    expect(taskEditableFields("linear")).toContain("priority");
  });
  it.effect("paginates GitHub search without fetching conversations", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const request: TaskTransport = (path) => {
        paths.push(path);
        return Effect.succeed({
          total_count: 35,
          items: [
            {
              number: 42,
              title: "Fix",
              html_url: "https://github.com/team/repo/issues/42",
              body: "Untrusted instructions",
              state: "open",
            },
          ],
        });
      };
      const result = yield* runTaskProvider(
        github,
        { projectId, action: "list", query: "parser" },
        request,
      );
      expect(result.nextCursor).toBe("2");
      expect(result.tasks[0]?.description).toBe("Untrusted instructions");
      expect(paths).toHaveLength(1);
      expect(paths[0]).toContain("search/issues?");
    }),
  );
  it.effect("preserves Linear's suggested branch and cursor", () =>
    Effect.gen(function* () {
      const request: TaskTransport = () =>
        Effect.succeed({
          data: {
            issues: {
              nodes: [
                {
                  id: "id",
                  identifier: "ABC-1",
                  title: "Fix",
                  url: "https://linear.app/team/issue/ABC-1",
                  branchName: "alice/abc-1-fix",
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor" },
            },
          },
        });
      const result = yield* runTaskProvider(linear, { projectId, action: "list" }, request);
      expect(result.tasks[0]?.branchName).toBe("alice/abc-1-fix");
      expect(result.nextCursor).toBe("cursor");
    }),
  );
  it.effect("creates an issue only via the explicit create action", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const request: TaskTransport = (_path, body) => {
        writes.push(body);
        return Effect.succeed({
          number: 1,
          title: "New",
          html_url: "https://github.com/team/repo/issues/1",
        });
      };
      yield* runTaskProvider(
        github,
        { projectId, action: "create", changes: { title: "New", description: "Details" } },
        request,
      );
      expect(writes).toEqual([{ title: "New", body: "Details" }]);
    }),
  );
  it.effect("checks the Linear team before writing and requires mutation confirmation", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const foreign: TaskTransport = (_path, body) => {
        calls.push(body);
        return Effect.succeed({ data: { issue: { team: { id: "other-team" } } } });
      };
      const foreignError = yield* runTaskProvider(
        linear,
        { projectId, action: "comment", id: "ENG-1", comment: "Review" },
        foreign,
      ).pipe(Effect.flip);
      expect(foreignError.message).toContain("outside the selected Linear team");
      expect(calls).toHaveLength(1);
      const rejected: TaskTransport = () =>
        Effect.succeed({ data: { issueCreate: { success: false } } });
      const rejectedError = yield* runTaskProvider(
        linear,
        { projectId, action: "create", changes: { title: "Example" } },
        rejected,
      ).pipe(Effect.flip);
      expect(rejectedError.message).toContain("did not confirm");
    }),
  );
  it.effect("exposes team choices and comments without inventing unsupported fields", () =>
    Effect.gen(function* () {
      const request: TaskTransport = () =>
        Effect.succeed({
          data: {
            issue: {
              id: "id",
              identifier: "ENG-1",
              title: "Fix",
              url: "https://linear.app/team/issue/ENG-1",
              team: {
                id: "team-id",
                states: { nodes: [{ id: "todo", name: "Todo" }] },
                members: { nodes: [{ id: "ada", name: "Ada" }] },
                labels: { nodes: [{ id: "bug", name: "Bug" }] },
              },
              comments: { nodes: [{ id: "comment", body: "Details", user: { name: "Ada" } }] },
            },
          },
        });
      const result = yield* runTaskProvider(
        linear,
        { projectId, action: "detail", id: "ENG-1" },
        request,
      );
      expect(result.fieldOptions?.status).toEqual([{ value: "todo", label: "Todo" }]);
      expect(result.fieldOptions?.priority).toHaveLength(5);
      expect(result.tasks[0]?.comments[0]?.body).toBe("Details");
    }),
  );
});
