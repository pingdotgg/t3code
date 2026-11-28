import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoIssueTracker from "./ForgejoIssueTracker.ts";

const encode = (value: unknown) => JSON.stringify(value);
const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);

const ISSUE = {
  number: 42,
  title: "Composer loses focus",
  body: "Typing drops focus.",
  html_url: "https://forgejo.test:3000/acme/web/issues/42",
  user: { login: "octocat", full_name: "Octo Cat", avatar_url: "" },
  state: "open",
  created_at: "2026-07-01T00:00:00+02:00",
  updated_at: "2026-07-03T00:00:00Z",
  closed_at: null,
  assignees: [{ login: "theo" }],
  labels: [{ id: 3, name: "bug", color: "d73a4a" }],
  comments: 1,
  is_locked: true,
};

/** Every endpoint the detail read touches, answered by path; stderr carries the `Link` header. */
function answer(path: string): { readonly stdout: string; readonly stderr?: string } {
  const [route] = path.split("?");
  switch (route) {
    case "user":
      return { stdout: encode({ login: "julius" }) };
    case "repos/acme/web":
      return {
        stdout: encode({ full_name: "acme/web", permissions: { push: false, admin: false } }),
      };
    case "repos/acme/web/issues/42":
      return { stdout: encode(ISSUE) };
    case "repos/acme/web/issues/42/timeline":
      // A second page, as an issue with a long history has: a reference from another repository.
      if (path.endsWith("page=2")) {
        return {
          stdout: encode([
            {
              id: 5,
              type: "pull_ref",
              user: { login: "theo" },
              created_at: "2026-07-02T03:00:00Z",
              ref_issue: {
                number: 50,
                html_url: "https://forgejo.test:3000/acme/api/pulls/50",
                repository: { full_name: "acme/api" },
                pull_request: { merged: true },
              },
            },
          ]),
        };
      }
      if (!path.endsWith("page=1")) return { stdout: "[]" };
      return {
        stdout: encode([
          {
            id: 1,
            type: "label",
            body: "1",
            user: { login: "theo" },
            created_at: "2026-07-01T01:00:00Z",
            label: { id: 3, name: "bug" },
          },
          {
            id: 2,
            type: "comment",
            body: "Repro attached.",
            user: { login: "julius" },
            created_at: "2026-07-02T00:00:00Z",
          },
          {
            id: 3,
            type: "pull_ref",
            user: { login: "theo" },
            created_at: "2026-07-02T01:00:00Z",
            ref_issue: {
              number: 50,
              html_url: "https://forgejo.test:3000/acme/web/pulls/50",
              pull_request: { merged: false },
            },
          },
          { id: 4, type: "milestone", user: { login: "theo" }, created_at: "2026-07-02T02:00:00Z" },
        ]),
      };
    case "repos/acme/web/issues/42/reactions":
      return { stdout: encode([{ content: "eyes", user: { login: "theo" } }]) };
    case "repos/acme/web/issues/42/comments":
      return {
        stdout: encode([
          {
            id: 7,
            body: "Repro attached.",
            user: { login: "julius" },
            created_at: "2026-07-02T00:00:00Z",
            html_url: "https://forgejo.test:3000/acme/web/issues/42#issuecomment-7",
          },
        ]),
      };
    case "repos/acme/web/issues/comments/7/reactions":
      return {
        stdout: encode([
          { content: "+1", user: { login: "julius" } },
          { content: "+1", user: { login: "theo" } },
        ]),
      };
    case "repos/acme/api/pulls/50":
      return {
        stdout: encode({
          number: 50,
          title: "fix(api): accept the pasted payload",
          html_url: "https://forgejo.test:3000/acme/api/pulls/50",
          state: "closed",
          merged: true,
        }),
      };
    case "repos/acme/web/pulls/50":
      return {
        stdout: encode({
          number: 50,
          title: "fix(web): keep composer focus",
          html_url: "https://forgejo.test:3000/acme/web/pulls/50",
          state: "open",
          merged: false,
          draft: true,
        }),
      };
    default:
      throw new Error(`unexpected path ${path}`);
  }
}

function tracker(
  onApi: (input: ForgejoCli.ForgejoApiInput) =>
    | {
        readonly stdout: string;
        readonly stderr?: string;
      }
    | ForgejoCli.ForgejoCliError,
) {
  return ForgejoIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          const result = onApi(input);
          return isForgejoCliError(result)
            ? Effect.fail(result)
            : Effect.succeed(
                TestSourceControlHost.processOutput(result.stdout, {
                  stderr: result.stderr ?? "",
                }),
              );
        },
      }),
    ),
  );
}

describe("ForgejoIssueTracker", () => {
  it.effect("joins the issue, timeline and conversation into the neutral issue shape", () =>
    Effect.gen(function* () {
      const hosts = new Set<string | undefined>();
      const api = yield* tracker((input) => {
        hosts.add(input.host);
        return answer(input.path);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      // The custom host and port reach the CLI, which resolves the login for them.
      expect([...hosts]).toEqual(["forgejo.test:3000"]);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        state: { category: "open", name: "Open" },
        states: [
          { category: "open", name: "Open" },
          { category: "closed", name: "Closed" },
        ],
        author: { login: "octocat", name: "Octo Cat", avatarUrl: null },
        createdAt: "2026-06-30T22:00:00.000Z",
        labels: [{ name: "bug", color: "d73a4a" }],
        viewer: "julius",
        // No push and not the author: nothing but reading. Locked, so not even a comment.
        viewerPermissions: {
          setState: false,
          comment: false,
          edit: false,
          labels: false,
          assignees: false,
        },
        reactions: [{ content: "eyes", count: 1, actors: ["theo"], viewerHasReacted: false }],
        // `/comments` answered with everything it has, so nothing is left to page.
        commentsCursor: null,
      });
      expect(issue.comments).toEqual([
        {
          id: "7",
          author: { login: "julius", name: null, avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00.000Z",
          url: "https://forgejo.test:3000/acme/web/issues/42#issuecomment-7",
          reactions: [{ content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true }],
        },
      ]);
      // Comments and milestones on the timeline are not events in the shared vocabulary.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["referenced", "#50"],
        ["referenced", "#50"],
      ]);
      // The same number in another repository is its own pull request, read from there.
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://forgejo.test:3000/acme/web/pulls/50",
          state: "open",
          isDraft: true,
          closesIssue: false,
        },
        {
          repository: "acme/api",
          number: 50,
          title: "fix(api): accept the pasted payload",
          url: "https://forgejo.test:3000/acme/api/pulls/50",
          state: "merged",
          isDraft: false,
          closesIssue: false,
        },
      ]);
    }),
  );

  it.effect("cuts the unpaged comments into pages and resolves labels past the first page", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, string, unknown]> = [];
      const api = yield* tracker((input) => {
        calls.push([input.method ?? "GET", input.path, input.body]);
        const [route] = input.path.split("?");
        if (route === "user") return { stdout: encode({ login: "julius" }) };
        if (route === "repos/acme/web/issues/42/comments") {
          return {
            stdout: encode(
              Array.from({ length: 51 }, (_, index) => ({
                id: index + 1,
                body: `Comment ${index + 1}`,
                user: { login: "theo" },
                created_at: "2026-07-02T00:00:00Z",
                html_url: "",
              })),
            ),
          };
        }
        if (route === "repos/acme/web/labels") {
          return input.path.endsWith("page=1")
            ? {
                stdout: encode([{ id: 3, name: "bug" }]),
                stderr: 'link: <https://forgejo.test:3000/api/v1/x?page=2>; rel="next"\n',
              }
            : { stdout: encode([{ id: 9, name: "urgent" }]), stderr: "link: \n" };
        }
        return { stdout: "[]" };
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      const page = yield* api.getComments({ ...target, cursor: "2" });
      expect(page.comments.map((comment) => comment.id)).toEqual(["51"]);
      expect(page.nextCursor).toBeNull();
      expect(calls[1]?.[1]).toBe("repos/acme/web/issues/42/comments");

      calls.length = 0;
      yield* api.update!({ ...target, labels: ["bug", "urgent"] });
      expect(calls.at(-1)).toEqual(["PUT", "repos/acme/web/issues/42/labels", { labels: [3, 9] }]);
      expect(calls.some(([, path]) => path.startsWith("orgs/"))).toBe(false);
      // A name neither the repository nor its org owns refuses the save before anything is written.
      calls.length = 0;
      const error = yield* Effect.flip(
        api.update!({ ...target, title: "Renamed", labels: ["bug", "missing"] }),
      );
      expect(error.reason).toBe("failed");
      expect(calls.map(([method]) => method)).toEqual(["GET", "GET", "GET"]);
    }),
  );

  it.effect("moves an issue to a state by its name and refuses any other name", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const api = yield* tracker((input) => {
        writes.push([input.method, input.path, input.body]);
        return { stdout: "{}" };
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      yield* api.setState!({ ...target, state: "Closed" });
      yield* api.setState!({ ...target, state: "Open" });
      // The category is not a state name: nothing is sent for it.
      const error = yield* Effect.flip(api.setState!({ ...target, state: "closed" }));
      expect(error).toMatchObject({ operation: "setState", reason: "failed" });
      expect(writes).toEqual([
        ["PATCH", "repos/acme/web/issues/42", { state: "closed" }],
        ["PATCH", "repos/acme/web/issues/42", { state: "open" }],
      ]);
    }),
  );

  it.effect("lists issues by page and leaves pull requests out of the rows", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return {
          stdout: encode([ISSUE, { ...ISSUE, number: 43, pull_request: { merged: false } }]),
        };
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        state: "open",
        involvement: "authored",
        viewer: "julius",
        sort: "updated",
        limit: 50,
        cursor: "2",
      });
      // Forgejo matches any of the labels it is sent, so a row missing one is dropped here.
      const filtered = yield* api.listIssues({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        state: "open",
        involvement: "all",
        labels: ["bug", "p1"],
        assignee: "theo",
        sort: "created",
        limit: 50,
      });
      expect(filtered.items).toEqual([]);
      // One `assigned_by` cannot name two people: "assigned to me" is kept by dropping rows here.
      const mine = {
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        state: "open",
        involvement: "assigned",
        assignee: "theo",
        sort: "created",
        limit: 50,
      } as const;
      expect((yield* api.listIssues({ ...mine, viewer: "julius" })).items).toEqual([]);
      expect(
        (yield* api.listIssues({ ...mine, viewer: "Theo" })).items.map((item) => item.key),
      ).toEqual(["42"]);
      expect(paths).toEqual([
        "repos/acme/web/issues?type=issues&state=open&sort=recentupdate&created_by=julius&limit=50&page=2",
        "repos/acme/web/issues?type=issues&state=open&sort=latest&labels=bug%2Cp1&assigned_by=theo&limit=50&page=1",
        "repos/acme/web/issues?type=issues&state=open&sort=latest&assigned_by=theo&limit=50&page=1",
        "repos/acme/web/issues?type=issues&state=open&sort=latest&assigned_by=theo&limit=50&page=1",
      ]);
      expect(page.items.map((item) => item.key)).toEqual(["42"]);
      // No `Link` header at all means the server may still have more; a full page carries on.
      expect(page.nextCursor).toBe("3");
    }),
  );

  it.effect("offers organization labels as candidates after the repository's own", () =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => {
        const [route] = input.path.split("?");
        if (route === "repos/acme/web/labels") {
          return { stdout: encode([{ id: 3, name: "bug", color: "d73a4a" }]), stderr: "link: \n" };
        }
        if (route === "orgs/acme/labels") {
          return {
            stdout: encode([
              { id: 99, name: "bug", color: "000000" },
              { id: 101, name: "security", color: "ff0000" },
            ]),
            stderr: 'link: <https://forgejo.test/api/v1/orgs/acme/labels?page=2>; rel="next"\n',
          };
        }
        return { stdout: "[]", stderr: "link: \n" };
      });
      const candidates = yield* api.listCandidates!({
        cwd: "/w",
        host: "forgejo.test",
        scope: "acme/web",
      });
      expect(candidates.labels).toEqual([
        { name: "bug", color: "d73a4a", description: null },
        { name: "security", color: "ff0000", description: null },
      ]);
      expect(candidates.truncated).toBe(true);
    }),
  );

  it.effect("writes organization labels by id, preferring the repository's label of a name", () =>
    Effect.gen(function* () {
      const writes: Array<readonly [string, string, unknown]> = [];
      const api = yield* tracker((input) => {
        const [route] = input.path.split("?");
        if (route === "repos/acme/web/labels") {
          return { stdout: encode([{ id: 3, name: "shared" }]), stderr: "link: \n" };
        }
        if (route === "orgs/acme/labels") {
          return input.path.endsWith("page=1")
            ? {
                stdout: encode([{ id: 99, name: "shared" }]),
                stderr: 'link: <https://forgejo.test/api/v1/orgs/acme/labels?page=2>; rel="next"\n',
              }
            : { stdout: encode([{ id: 102, name: "org-b" }]), stderr: "link: \n" };
        }
        writes.push([input.method ?? "GET", input.path, input.body]);
        return { stdout: "{}" };
      });
      yield* api.update!({
        cwd: "/w",
        host: "forgejo.test",
        scope: "acme/web",
        key: "42",
        labels: ["shared", "org-b"],
      });
      expect(writes).toEqual([["PUT", "repos/acme/web/issues/42/labels", { labels: [3, 102] }]]);
    }),
  );

  it.effect("reads organization labels from the owner when the scope carries a mount path", () =>
    Effect.gen(function* () {
      const writes: Array<readonly [string, string, unknown]> = [];
      const api = yield* tracker((input) => {
        const [route] = input.path.split("?");
        if (route === "orgs/acme/labels") {
          return { stdout: encode([{ id: 101, name: "org-only" }]) };
        }
        if (route === "repos/forgejo/acme/web/labels") return { stdout: "[]" };
        writes.push([input.method ?? "GET", input.path, input.body]);
        return { stdout: "{}" };
      });
      yield* api.update!({
        cwd: "/w",
        host: "forgejo.test",
        scope: "forgejo/acme/web",
        key: "42",
        labels: ["org-only"],
      });
      expect(writes).toEqual([
        ["PUT", "repos/forgejo/acme/web/issues/42/labels", { labels: [101] }],
      ]);
    }),
  );

  it.effect(
    "treats a personal owner (404) or a token without org scope (403) as no org labels",
    () =>
      Effect.gen(function* () {
        for (const [reason, httpStatus] of [
          ["not-found", 404],
          ["forbidden", 403],
        ] as const) {
          const api = yield* tracker((input) => {
            const [route] = input.path.split("?");
            if (route === "orgs/alice/labels") {
              return new ForgejoCli.ForgejoCliError({
                command: "fj",
                cwd: "/w",
                detail: String(httpStatus),
                reason,
                httpStatus,
              });
            }
            if (route === "repos/alice/web/labels") {
              return { stdout: encode([{ id: 3, name: "bug" }]), stderr: "link: \n" };
            }
            return { stdout: "[]", stderr: "link: \n" };
          });
          const candidates = yield* api.listCandidates!({
            cwd: "/w",
            host: "forgejo.test",
            scope: "alice/web",
          });
          expect(candidates.labels.map((label) => label.name)).toEqual(["bug"]);
          const error = yield* Effect.flip(
            api.update!({
              cwd: "/w",
              host: "forgejo.test",
              scope: "alice/web",
              key: "42",
              labels: ["missing"],
            }),
          );
          expect(error.detail).toBe("Forgejo found no label by one of the names given.");
        }
      }),
  );
});
