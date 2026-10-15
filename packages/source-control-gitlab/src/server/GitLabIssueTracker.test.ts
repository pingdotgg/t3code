import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabIssueTracker from "./GitLabIssueTracker.ts";

const encode = (value: unknown) => JSON.stringify(value);

const ISSUE_PERMISSIONS = {
  updateIssue: true,
  reopenIssue: true,
  createNote: true,
  adminIssue: true,
};

const ISSUE = {
  iid: 42,
  title: "Composer loses focus",
  web_url: "https://gitlab.com/acme/web/-/issues/42",
  description: "Typing in the composer drops focus after a paste.",
  author: { id: 1, username: "octocat", name: "Octo Cat", avatar_url: "https://avatars/octocat" },
  state: "closed",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-03T00:00:00Z",
  closed_at: "2026-07-03T00:00:00Z",
  assignees: [{ id: 2, username: "theo", name: null }],
  labels: ["bug", " "],
  user_notes_count: 3,
};

/** Every endpoint the detail read touches, answered by the path `glab api` is given. */
function answer(path: string): string {
  if (path === "user") return encode({ username: "julius" });
  if (path.startsWith("projects/acme%2Fweb/issues/42/award_emoji")) {
    return encode([{ id: 1, name: "eyes", user: { username: "theo" } }]);
  }
  if (path === "projects/acme%2Fweb/issues/42") return encode(ISSUE);
  if (path.startsWith("projects/acme%2Fweb/issues/42/resource_label_events")) {
    return encode([
      {
        id: 3,
        action: "add",
        created_at: "2026-07-01T01:00:00Z",
        user: { username: "theo" },
        label: { name: "bug" },
      },
    ]);
  }
  if (path.startsWith("projects/acme%2Fweb/issues/42/closed_by")) {
    return encode([
      {
        iid: 50,
        title: "fix(web): keep composer focus",
        web_url: "https://gitlab.com/acme/web/-/merge_requests/50",
        state: "merged",
        references: { full: "acme/web!50" },
      },
    ]);
  }
  if (path.startsWith("projects/acme%2Fweb/issues/42/related_merge_requests")) {
    return encode([
      {
        iid: 50,
        title: "fix(web): keep composer focus",
        web_url: "https://gitlab.com/acme/web/-/merge_requests/50",
        state: "merged",
        references: { full: "acme/web!50" },
      },
      {
        iid: 51,
        title: "chore: mention",
        web_url: "https://gitlab.com/acme/web/-/merge_requests/51",
        state: "opened",
        draft: true,
        references: { full: "acme/web!51" },
      },
    ]);
  }
  if (path === "graphql") {
    return encode({
      data: {
        currentUser: { username: "julius" },
        project: {
          archived: false,
          mergeRequest: {
            state: "closed",
            userPermissions: ISSUE_PERMISSIONS,
            notes: {
              pageInfo: { hasPreviousPage: false, startCursor: "native-note-7" },
              nodes: [
                {
                  id: "gid://gitlab/Note/7",
                  body: "Repro attached.",
                  author: { username: "julius" },
                  createdAt: "2026-07-02T00:00:00Z",
                  awardEmoji: {
                    nodes: [
                      { name: "thumbsup", user: { username: "julius" } },
                      { name: "thumbsup", user: { username: "theo" } },
                    ],
                  },
                },
                {
                  id: "gid://gitlab/Note/8",
                  body: "closed",
                  author: { username: "theo" },
                  createdAt: "2026-07-03T00:00:00Z",
                  system: true,
                },
                {
                  id: "gid://gitlab/Note/9",
                  body: "added ~7 label",
                  author: { username: "theo" },
                  createdAt: "2026-07-03T00:00:00Z",
                  system: true,
                },
              ],
            },
          },
        },
      },
    });
  }
  throw new Error(`unexpected path ${path}`);
}

function tracker(onExecute: (args: ReadonlyArray<string>, stdin?: string) => string) {
  return GitLabIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: ({ args, stdin }) =>
          Effect.succeed(TestSourceControlHost.processOutput(onExecute(args, stdin))),
      }),
    ),
  );
}

describe("GitLabIssueTracker", () => {
  it.effect.each([
    { selected: ["2", "3"], saved: [2], warning: true },
    { selected: ["2", "3"], saved: [3, 2], warning: false },
    { selected: [], saved: [], warning: false },
    { selected: ["2"], saved: [], warning: true },
  ])("keeps created identity and warns for omitted assignees: $selected/$saved", (input) =>
    Effect.gen(function* () {
      const requests: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args, stdin) => {
        requests.push(args);
        expect(JSON.parse(stdin!)).toEqual({
          title: "Track release",
          description: "Release checks",
          labels: "",
          assignee_ids: input.selected.map(Number),
        });
        return encode({
          ...ISSUE,
          assignees: input.saved.map((id) => ({ id, username: "member" + id })),
        });
      });
      const result = yield* api.create!({
        cwd: "/w",
        host: "gitlab.acme.test",
        scope: "acme/web",
        title: "Track release",
        body: "Release checks",
        labels: [],
        assignees: input.selected,
      });
      expect(result).toMatchObject({
        key: "42",
        displayKey: "#42",
        url: ISSUE.web_url,
      });
      expect(result.warnings ?? []).toEqual(
        input.warning
          ? ["The issue was created, but GitLab did not save the requested assignees."]
          : [],
      );
      expect(requests).toEqual([
        [
          "api",
          "projects/acme%2Fweb/issues",
          "--hostname",
          "gitlab.acme.test",
          "--method",
          "POST",
          "--input",
          "-",
          "--header",
          "Content-Type: application/json",
        ],
      ]);
    }),
  );

  it.effect("preserves native create403 without a retry or follow-up read", () =>
    Effect.gen(function* () {
      let calls = 0;
      const native = new GitLabCli.GitLabCliCommandError({
        command: "glab",
        operation: "execute",
        cwd: "/w",
        cause: new Error("HTTP403 Forbidden"),
      });
      const api = yield* GitLabIssueTracker.make.pipe(
        Effect.provide(
          Layer.mock(GitLabCli.GitLabCli)({
            execute: () => {
              calls++;
              return Effect.fail(native);
            },
          }),
        ),
      );
      const error = yield* Effect.flip(
        api.create!({
          cwd: "/w",
          host: "gitlab.acme.test",
          scope: "acme/web",
          title: "Track release",
          body: "",
          labels: [],
          assignees: ["2", "3"],
        }),
      );
      expect(error).toMatchObject({ operation: "create", reason: "failed", cause: native });
      expect(calls).toBe(1);
    }),
  );

  it.effect.each([false, true])(
    "keeps native author title writes and token refusal: $value",
    (denied) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const native = new GitLabCli.GitLabCliCommandError({
          command: "glab",
          operation: "execute",
          cwd: "/w",
          cause: new Error("HTTP 403 Forbidden"),
        });
        const api = yield* GitLabIssueTracker.make.pipe(
          Effect.provide(
            Layer.mock(GitLabCli.GitLabCli)({
              execute: ({ args, stdin }) => {
                paths.push(args[1]!);
                if (args.includes("PUT")) {
                  expect(JSON.parse(stdin!)).toEqual({ title: "Updated" });
                  return denied
                    ? Effect.fail(native)
                    : Effect.succeed(
                        TestSourceControlHost.processOutput(encode({ ...ISSUE, title: "Updated" })),
                      );
                }
                const response = JSON.parse(answer("graphql"));
                response.data.project.mergeRequest.userPermissions.adminIssue = false;
                return Effect.succeed(TestSourceControlHost.processOutput(encode(response)));
              },
            }),
          ),
        );
        const target = { cwd: "/w", host: "gitlab.acme.test", scope: "acme/web", key: "42" };
        const permission = yield* api.getViewerPermissions(target);
        expect(permission.edit).toBe(true);
        expect(permission.labels).toBe(false);
        const result = yield* Effect.result(api.update!({ ...target, title: "Updated" }));
        expect(Result.isFailure(result)).toBe(denied);
        if (Result.isFailure(result))
          expect(result.failure).toMatchObject({
            operation: "update",
            reason: "failed",
            cause: native,
          });
        expect(paths).toEqual(["graphql", "projects/acme%2Fweb/issues/42"]);
      }),
  );

  it.effect.each([
    {
      archived: false,
      admin: false,
      update: true,
      reopen: true,
      note: true,
      state: "opened",
      expected: { edit: true, setState: true, comment: true, labels: false, assignees: false },
    },
    {
      archived: false,
      admin: true,
      update: true,
      reopen: true,
      note: true,
      state: "closed",
      expected: { edit: true, setState: true, comment: true, labels: true, assignees: true },
    },
    {
      archived: true,
      admin: true,
      update: true,
      reopen: true,
      note: true,
      state: "opened",
      expected: { edit: false, setState: false, comment: false, labels: false, assignees: false },
    },
    {
      archived: false,
      admin: false,
      update: false,
      reopen: false,
      note: false,
      state: "closed",
      expected: { edit: false, setState: false, comment: false, labels: false, assignees: false },
    },
    {
      archived: false,
      admin: false,
      update: true,
      reopen: false,
      note: true,
      state: "closed",
      expected: { edit: true, setState: false, comment: true, labels: false, assignees: false },
    },
  ])("uses native issue permissions: $archived/$admin/$state/$reopen", (input) =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args, stdin) => {
        paths.push(args[1]!);
        if (args[1] !== "graphql") return answer(args[1]!);
        const request = JSON.parse(stdin!);
        expect(request.query).toContain("archived");
        if (!request.query.includes("notes(")) {
          expect(request.query).not.toContain("currentUser");
          expect(request.variables).toEqual({ fullPath: "acme/web", iid: "42" });
        }
        expect(request.query).toContain(
          "userPermissions { updateIssue reopenIssue createNote adminIssue }",
        );
        const response = JSON.parse(answer("graphql"));
        response.data.project.archived = input.archived;
        response.data.project.mergeRequest.state = input.state;
        response.data.project.mergeRequest.userPermissions = {
          updateIssue: input.update,
          reopenIssue: input.reopen,
          createNote: input.note,
          adminIssue: input.admin,
        };
        return encode(response);
      });
      const target = { cwd: "/w", host: "gitlab.acme.test", scope: "acme/web", key: "42" };
      expect(yield* api.getViewerPermissions(target)).toEqual(input.expected);
      expect(paths).toEqual(["graphql"]);
      expect((yield* api.getIssue(target)).viewerPermissions).toEqual(input.expected);
      expect(paths).toHaveLength(7);
      expect(paths).not.toContain("user");
    }),
  );

  it.effect.each(["labels", "assignees"] as const)(
    "refuses silently dropped %s after one native PUT",
    (field) =>
      Effect.gen(function* () {
        const requests: ReadonlyArray<string>[] = [];
        const api = yield* tracker((args) => {
          requests.push(args);
          return encode({ labels: ["old"], assignees: [{ id: 2 }] });
        });
        const error = yield* Effect.flip(
          api.update!({
            cwd: "/w",
            host: "gitlab.acme.test",
            scope: "acme/web",
            key: "42",
            ...(field === "labels" ? { labels: ["new"] } : { assignees: ["6"] }),
          }),
        );
        expect(error).toMatchObject({ operation: "update", reason: "failed" });
        expect(error.detail).toContain(field);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain("PUT");
      }),
  );

  it.effect.each([
    { name: "missing fields", raw: "{}", truncated: false },
    { name: "invalid JSON", raw: "{", truncated: false },
    {
      name: "truncated fields",
      raw: '{"labels":["bug"],"assignees":[{"id":2}]}',
      truncated: true,
    },
  ])("refuses unreadable metadata acknowledgements: $name", (input) =>
    Effect.gen(function* () {
      let calls = 0;
      const api = yield* GitLabIssueTracker.make.pipe(
        Effect.provide(
          Layer.mock(GitLabCli.GitLabCli)({
            execute: ({ args }) => {
              calls++;
              expect(args).toContain("PUT");
              return Effect.succeed({
                ...TestSourceControlHost.processOutput(input.raw),
                stdoutTruncated: input.truncated,
              });
            },
          }),
        ),
      );
      const error = yield* Effect.flip(
        api.update!({
          cwd: "/w",
          host: "gitlab.acme.test",
          scope: "acme/web",
          key: "42",
          labels: ["bug"],
          assignees: ["2"],
        }),
      );
      expect(error).toMatchObject({ operation: "update", reason: "failed" });
      expect(calls).toBe(1);
    }),
  );

  it.effect("verifies metadata using the existing native update response", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args, stdin) => {
        paths.push(args[1]!);
        if (args[1] === "graphql") return answer("graphql");
        expect(JSON.parse(stdin!)).toEqual({ labels: "bug,urgent", assignee_ids: [2, 6] });
        return encode({ labels: ["urgent", "bug"], assignees: [{ id: 6 }, { id: 2 }] });
      });
      const target = { cwd: "/w", host: "gitlab.acme.test", scope: "acme/web", key: "42" };
      expect((yield* api.getViewerPermissions(target)).labels).toBe(true);
      yield* api.update!({ ...target, labels: ["bug", "urgent"], assignees: ["2", "6"] });
      expect(paths).toEqual(["graphql", "projects/acme%2Fweb/issues/42"]);
    }),
  );

  it.effect("shows a new reply beyond 100 notes and pages back into older notes", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      let count = 100;
      const notes = Array.from({ length: 101 }, (_, index) => ({
        id: `gid://gitlab/Note/${index + 1}`,
        body: `Reply ${index + 1}`,
        createdAt: DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe("2026-07-01T00:00:00Z"), { minutes: index }),
        ),
        author: { username: "julius" },
      }));
      const api = yield* tracker((args, stdin) => {
        const path = args[1]!;
        paths.push(path);
        if (path === "projects/acme%2Fweb/issues/42/notes") {
          expect(args).toContain("POST");
          expect(JSON.parse(stdin!)).toEqual({ body: "Reply 101" });
          count++;
          return "{}";
        }
        if (path === "projects/acme%2Fweb/issues/42")
          return encode({ ...ISSUE, user_notes_count: count });
        if (path !== "graphql") return answer(path);
        const request = JSON.parse(stdin!);
        const backward = request.query.includes("notes(last: 100, before: $cursor)");
        const cursor = request.variables.cursor;
        const position = cursor === undefined ? undefined : Number(cursor.split("-").at(-1)) - 1;
        const start = backward ? Math.max(0, (position ?? count) - 100) : (position ?? -1) + 1;
        const end = backward ? (position ?? count) : Math.min(count, start + 100);
        return encode({
          data: {
            currentUser: { username: "julius" },
            project: {
              archived: false,
              mergeRequest: {
                state: "closed",
                userPermissions: ISSUE_PERMISSIONS,
                notes: {
                  pageInfo: backward
                    ? { hasPreviousPage: start > 0, startCursor: `native-note-${start + 1}` }
                    : { hasNextPage: end < count, endCursor: `native-note-${end}` },
                  nodes: notes.slice(start, end),
                },
              },
            },
          },
        });
      });
      const target = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42" };
      const initial = yield* api.getIssue(target);
      expect(initial.comments).toHaveLength(100);
      expect(initial.commentsCursor).toBeNull();
      expect(paths).toHaveLength(6);
      yield* api.comment!({ ...target, body: "Reply 101" });
      const refreshed = yield* api.getIssue(target);
      expect(refreshed.commentCount).toBe(101);
      expect(refreshed.comments.map((comment) => comment.id)).toEqual(
        Array.from({ length: 100 }, (_, index) => String(index + 2)),
      );
      expect(refreshed.commentsCursor).toBe("native-note-2");
      expect(refreshed.historyTruncated).toBe(true);
      expect(paths).toHaveLength(13);
      const older = yield* api.getComments({ ...target, cursor: refreshed.commentsCursor! });
      expect(older.comments.map((comment) => comment.id)).toEqual(["1"]);
      expect(older.nextCursor).toBeNull();
      expect(paths).toHaveLength(14);
      expect(paths.filter((path) => path === "graphql")).toHaveLength(3);
      expect(paths).not.toContain("user");
    }),
  );

  it.effect.each(["getIssue", "getComments"] as const)(
    "uses valid native issue fields in %s and preserves viewer reactions",
    (operation) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((args, stdin) => {
          const path = args[1]!;
          paths.push(path);
          if (path.includes("/award_emoji")) {
            expect(path).toBe("projects/acme%2Fweb/issues/42/award_emoji?per_page=100&page=1");
            return encode([
              { id: 1, name: "thumbsup", user: { username: "Julius" } },
              { id: 2, name: "thumbsup", user: { username: "theo" } },
            ]);
          }
          if (path !== "graphql") return answer(path);
          const request = JSON.parse(stdin!);
          if (/mergeRequest: issue\([^)]*\)\s*\{\s*awardEmoji/.test(request.query)) {
            return encode({
              errors: [{ message: "Field 'awardEmoji' doesn't exist on type 'Issue'" }],
            });
          }
          expect(request.query.match(/\bawardEmoji\(/g)).toHaveLength(1);
          expect(request.query).toMatch(
            /nodes\s*\{\s*id body createdAt system\s*author\s*\{[^}]*\}\s*awardEmoji\(first: 100\)/,
          );
          return answer(path);
        });
        const target = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42" };
        if (operation === "getIssue") {
          const detail = yield* api.getIssue(target);
          expect(detail.viewer).toBe("julius");
          expect(detail.reactions).toEqual([
            { content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true },
          ]);
          expect(detail.reactionsTruncated).toBe(false);
          expect(paths).toHaveLength(6);
          expect(paths).not.toContain("user");
        } else {
          const page = yield* api.getComments({ ...target, cursor: "native-note-7" });
          expect(page.comments[0]?.reactions).toEqual([
            { content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true },
          ]);
          expect(paths).toEqual(["graphql"]);
        }
      }),
  );

  it.effect.each(["invalid JSON", "missing page info", "missing viewer"] as const)(
    "refuses a continuation with %s instead of returning an empty terminal page",
    (failure) =>
      Effect.gen(function* () {
        let reads = 0;
        const api = yield* tracker(() => {
          reads++;
          if (failure === "invalid JSON") return "{";
          const response = JSON.parse(answer("graphql"));
          if (failure === "missing page info")
            delete response.data.project.mergeRequest.notes.pageInfo;
          else response.data.currentUser = null;
          return encode(response);
        });
        const error = yield* Effect.flip(
          api.getComments({
            cwd: "/w",
            host: "gitlab.com",
            scope: "acme/web",
            key: "42",
            cursor: "native-note-7",
          }),
        );
        expect(error).toMatchObject({ operation: "getComments", reason: "failed" });
        expect(reads).toBe(1);
      }),
  );

  it.effect.each([
    { mode: "body", name: "missing content", raw: "{}", truncated: false },
    { mode: "body", name: "null content", raw: '{"content":null}', truncated: false },
    { mode: "body", name: "wrong content type", raw: '{"content":42}', truncated: false },
    { mode: "body", name: "invalid JSON", raw: "{", truncated: false },
    { mode: "body", name: "truncated content", raw: '{"content":"Partial body"}', truncated: true },
    { mode: "catalog", name: "null", raw: "null", truncated: false },
    { mode: "catalog", name: "wrong shape", raw: "{}", truncated: false },
    { mode: "catalog", name: "missing key", raw: '[{"key":"Bug"},{}]', truncated: false },
    { mode: "catalog", name: "null key", raw: '[{"key":null}]', truncated: false },
    { mode: "catalog", name: "blank key", raw: '[{"key":" "}]', truncated: false },
    { mode: "catalog", name: "invalid JSON", raw: "[", truncated: false },
    { mode: "catalog", name: "truncated", raw: '[{"key":"Bug"}]', truncated: true },
  ])("refuses unreadable template $mode: $name", (input) =>
    Effect.gen(function* () {
      let calls = 0;
      const api = yield* GitLabIssueTracker.make.pipe(
        Effect.provide(
          Layer.mock(GitLabCli.GitLabCli)({
            execute: () =>
              Effect.sync(() => {
                calls++;
                return {
                  ...TestSourceControlHost.processOutput(input.raw),
                  stdoutTruncated: input.truncated,
                };
              }),
          }),
        ),
      );
      expect(
        yield* Effect.flip(
          api.listTemplates!({
            cwd: "/w",
            host: "gitlab.com",
            scope: "acme/web",
            ...(input.mode === "body" ? { templateKey: "Bug" } : { metadataOnly: true }),
          }),
        ),
      ).toMatchObject({ operation: "listTemplates", reason: "failed" });
      expect(calls).toBe(1);
    }),
  );

  it.effect.each(["404", "rate-limit"] as const)(
    "keeps native selected template %s errors typed",
    (kind) =>
      Effect.gen(function* () {
        let calls = 0;
        const context = {
          command: "glab" as const,
          operation: "execute" as const,
          cwd: "/w",
          cause: new Error(kind === "404" ? "HTTP 404 Not Found" : "HTTP 429 Rate limit"),
        };
        const native =
          kind === "404"
            ? new GitLabCli.GitLabCliCommandError(context)
            : new GitLabCli.GitLabCliRateLimitError(context);
        const api = yield* GitLabIssueTracker.make.pipe(
          Effect.provide(
            Layer.mock(GitLabCli.GitLabCli)({
              execute: () => {
                calls++;
                return Effect.fail(native);
              },
            }),
          ),
        );
        const error = yield* Effect.flip(
          api.listTemplates!({
            cwd: "/w",
            host: "gitlab.com",
            scope: "acme/web",
            templateKey: "Unknown",
          }),
        );
        expect(error).toMatchObject({
          operation: "listTemplates",
          reason: kind === "404" ? "failed" : "rate-limited",
          cause: native,
        });
        expect(calls).toBe(1);
      }),
  );

  it.effect("refuses ambiguous template modes before a native request", () =>
    Effect.gen(function* () {
      let calls = 0;
      const api = yield* tracker(() => {
        calls++;
        return "[]";
      });
      expect(
        yield* Effect.flip(
          api.listTemplates!({
            cwd: "/w",
            host: "gitlab.com",
            scope: "acme/web",
            metadataOnly: true,
            templateKey: "Bug",
          }),
        ),
      ).toMatchObject({ operation: "listTemplates", reason: "failed" });
      expect(calls).toBe(0);
    }),
  );

  it.effect("keeps a native empty template body loaded rather than deferred", () =>
    Effect.gen(function* () {
      const api = yield* tracker(() => encode({ content: "" }));
      const result = yield* api.listTemplates!({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        templateKey: "Empty",
      });
      expect(result.templates[0]).toMatchObject({ key: "Empty", body: "" });
      expect(result.templates[0]?.contentDeferred).not.toBe(true);
    }),
  );

  it.effect("lists 100 deferred choices and reads only the selected hundredth body", () =>
    Effect.gen(function* () {
      const entries = Array.from({ length: 100 }, (_, index) => ({
        key: index === 99 ? "Bug / UI" : `Key ${index}`,
        name: `Name ${index}`,
      }));
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        paths.push(args[1]!);
        expect(args[args.indexOf("--hostname") + 1]).toBe("git.acme.test");
        return args[1]!.endsWith("/templates/issues")
          ? encode(entries)
          : encode({
              name: "Native override",
              content: "## Closest group template\nEdit this body.",
            });
      });
      expect(
        yield* api.listTemplates!({
          cwd: "/w",
          host: "git.acme.test",
          scope: "acme/web",
          metadataOnly: true,
        }),
      ).toEqual({
        templates: entries.map((entry) => ({
          ...entry,
          about: "",
          title: "",
          body: "",
          labels: [],
          assignees: [],
          contentDeferred: true,
        })),
        blankIssuesEnabled: true,
      });
      expect(paths).toEqual(["projects/acme%2Fweb/templates/issues"]);
      const selected = yield* api.listTemplates!({
        cwd: "/w",
        host: "git.acme.test",
        scope: "acme/web",
        templateKey: entries[99]!.key,
      });
      expect(selected.templates).toEqual([
        {
          key: "Bug / UI",
          name: "Bug / UI",
          about: "",
          title: "",
          body: "## Closest group template\nEdit this body.",
          labels: [],
          assignees: [],
        },
      ]);
      expect(selected.blankIssuesEnabled).toBe(true);
      expect(paths).toEqual([
        "projects/acme%2Fweb/templates/issues",
        "projects/acme%2Fweb/templates/issues/Bug%20%2F%20UI",
      ]);
    }),
  );

  it.effect("refuses an over-limit catalog before any template body reads", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        paths.push(args[1]!);
        return args[1]!.endsWith("/templates/issues")
          ? encode(Array.from({ length: 101 }, (_, index) => ({ key: `Key ${index}` })))
          : encode({ content: "Native body" });
      });
      expect(
        yield* Effect.flip(
          api.listTemplates!({
            cwd: "/w",
            host: "gitlab.com",
            scope: "acme/web",
            metadataOnly: true,
          }),
        ),
      ).toMatchObject({
        operation: "listTemplates",
        reason: "failed",
        detail: "This project exceeds the supported template limit of 100.",
      });
      expect(paths).toEqual(["projects/acme%2Fweb/templates/issues"]);
    }),
  );

  it.effect("keeps the legacy inline template request bounded at twenty bodies", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        paths.push(args[1]!);
        return args[1]!.endsWith("/templates/issues")
          ? encode([
              {},
              { key: " " },
              ...Array.from({ length: 101 }, (_, index) => ({ key: `Key ${index}` })),
            ])
          : encode({ content: "Native body" });
      });
      const result = yield* api.listTemplates!({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
      });
      expect(result.templates).toHaveLength(20);
      expect(
        result.templates.every(
          (template) => template.body === "Native body" && template.contentDeferred !== true,
        ),
      ).toBe(true);
      expect(paths).toHaveLength(21);
    }),
  );

  it.effect("pins every issue read and write to the selected GitLab host", () =>
    Effect.gen(function* () {
      const requests: ReadonlyArray<string>[] = [];
      const api = yield* tracker((args) => {
        requests.push(args);
        return args.includes("PUT") ? "{}" : answer(args[1]!);
      });
      const target = { cwd: "/w", host: "gitlab.acme.test", scope: "acme/web", key: "42" };
      yield* api.getIssue(target);
      yield* api.update!({ ...target, title: "Updated title" });
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.every((args) => args[args.indexOf("--hostname") + 1] === target.host)).toBe(
        true,
      );
    }),
  );

  it.effect("refuses unsupported mention filtering before making a native request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return "[]";
      });
      const error = yield* Effect.flip(
        api.listIssues({
          cwd: "/w",
          host: "gitlab.com",
          scope: "acme/web",
          state: "all",
          involvement: "mentioned",
          viewer: "julius",
          limit: 20,
        }),
      );
      expect(error.reason).toBe("failed");
      expect(requests).toBe(0);
      expect(api.capabilities.involvements).toEqual(["all", "assigned", "authored"]);
    }),
  );

  it.effect("keeps numeric actor IDs when current and candidate assignees are sent back", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      let sentBody: string | undefined;
      const api = yield* tracker((args, stdin) => {
        paths.push(args[1]!);
        if (args.includes("PUT")) {
          sentBody = stdin;
          return encode({
            ...ISSUE,
            assignees: JSON.parse(stdin!).assignee_ids.map((id: number) => ({ id })),
          });
        }
        if (args[1]?.startsWith("projects/acme%2Fweb/members")) {
          return encode([{ id: 6, username: "alice" }]);
        }
        if (args[1]?.startsWith("projects/acme%2Fweb/labels")) return "[]";
        return answer(args[1]!);
      });
      const context = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42" };
      const issue = yield* api.getIssue(context);
      const candidates = yield* api.listCandidates!(context);
      expect(issue.author?.id).toBe("1");
      expect(issue.assignees[0]?.id).toBe("2");
      yield* api.update!({
        ...context,
        assignees: [...issue.assignees.map((actor) => actor.id!), candidates.assignees[0]!.id],
      });
      expect(paths.at(-1)).toBe("projects/acme%2Fweb/issues/42");
      expect(sentBody).toBe(encode({ assignee_ids: [2, 6] }));
    }),
  );

  it.effect("removes the viewer's reaction beyond the first awards page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        const path = args[1]!;
        paths.push(path);
        if (path === "user") return encode({ username: "julius" });
        if (args.includes("DELETE")) return "{}";
        return encode(
          path.endsWith("page=1")
            ? Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                name: "thumbsup",
                user: { username: "theo" },
              }))
            : [{ id: 101, name: "thumbsup", user: { username: "julius" } }],
        );
      });
      yield* api.setReaction!({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
        subjectId: "7",
        content: "thumbs-up",
        reacted: false,
      });
      expect(paths.slice(1)).toEqual([
        "projects/acme%2Fweb/issues/42/notes/7/award_emoji?per_page=100&page=1",
        "projects/acme%2Fweb/issues/42/notes/7/award_emoji?per_page=100&page=2",
        "projects/acme%2Fweb/issues/42/notes/7/award_emoji/101",
      ]);
    }),
  );

  it.effect("fails instead of claiming removal when the awards search reaches its bound", () =>
    Effect.gen(function* () {
      const methods: string[] = [];
      const api = yield* tracker((args) => {
        methods.push(args.includes("DELETE") ? "DELETE" : "GET");
        return args[1] === "user"
          ? encode({ username: "julius" })
          : encode(
              Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                name: "eyes",
                user: { username: "theo" },
              })),
            );
      });
      const error = yield* Effect.flip(
        api.setReaction!({
          cwd: "/w",
          host: "gitlab.com",
          scope: "acme/web",
          key: "42",
          content: "thumbs-up",
          reacted: false,
        }),
      );
      expect(error.reason).toBe("failed");
      expect(methods).toHaveLength(11);
      expect(methods).not.toContain("DELETE");
    }),
  );

  it.effect("loads native reactions for comments on a continuation page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      let sentBody: string | undefined;
      const api = yield* tracker((args, stdin) => {
        const path = args[1]!;
        paths.push(path);
        sentBody = stdin;
        return encode({
          data: {
            currentUser: { username: "julius" },
            project: {
              archived: false,
              mergeRequest: {
                state: "closed",
                userPermissions: ISSUE_PERMISSIONS,
                notes: {
                  pageInfo: { hasPreviousPage: true, startCursor: "native-next" },
                  nodes: [
                    {
                      id: "gid://gitlab/Note/107",
                      body: "Older page",
                      author: { id: "gid://gitlab/User/2", username: "theo" },
                      createdAt: "2026-07-02T00:00:00Z",
                      awardEmoji: {
                        pageInfo: { hasNextPage: true },
                        nodes: [
                          { name: "thumbsup", user: { username: "julius" } },
                          { name: "thumbsup", user: { username: "theo" } },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      });
      const page = yield* api.getComments({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
        cursor: "native-cursor",
      });
      expect(page.comments[0]?.author?.id).toBe("2");
      expect(page.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true },
      ]);
      expect(page.comments[0]?.reactionsTruncated).toBe(true);
      expect(page.nextCursor).toBe("native-next");
      expect(paths).toEqual(["graphql"]);
      expect(sentBody).toContain('"cursor":"native-cursor"');
    }),
  );

  it.effect("marks partial detail reactions and history without reading more pages", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        const path = args[1]!;
        paths.push(path);
        if (path.includes("/award_emoji"))
          return encode(
            Array.from({ length: 100 }, (_, id) => ({
              id,
              name: "eyes",
              user: { username: "theo" },
            })),
          );
        if (path !== "graphql") return answer(path);
        return encode({
          data: {
            currentUser: { username: "julius" },
            project: {
              archived: false,
              mergeRequest: {
                state: "closed",
                userPermissions: ISSUE_PERMISSIONS,
                notes: {
                  pageInfo: { hasPreviousPage: true, startCursor: "native-next" },
                  nodes: [
                    {
                      id: "gid://gitlab/Note/108",
                      body: "closed",
                      system: true,
                      author: { id: "gid://gitlab/User/2", username: "theo" },
                      createdAt: "2026-07-02T00:00:00Z",
                    },
                  ],
                },
              },
            },
          },
        });
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
      });
      expect(issue.reactionsTruncated).toBe(true);
      expect(issue.historyTruncated).toBe(true);
      expect(issue.commentsCursor).toBe("native-next");
      expect(issue.comments).toEqual([]);
      expect(issue.events).toContainEqual({
        id: "note-108",
        kind: "closed",
        actor: { id: "2", login: "theo", name: null, avatarUrl: null },
        createdAt: "2026-07-02T00:00:00Z",
        detail: null,
      });
      expect(paths).toHaveLength(6);
      expect(paths.filter((path) => path === "graphql")).toHaveLength(1);
      expect(paths.some((path) => path.includes("/notes"))).toBe(false);
    }),
  );

  it.effect("joins the detail's endpoints into the neutral issue shape", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) => answer(args[1]!));
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
      });
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        state: { category: "closed", name: "closed" },
        author: { login: "octocat", name: "Octo Cat" },
        assignees: [{ login: "theo" }],
        labels: [{ name: "bug", color: null }],
        commentCount: 3,
        viewer: "julius",
        viewerPermissions: { setState: true, edit: true, labels: true, assignees: true },
        commentsCursor: null,
        reactions: [{ content: "eyes", count: 1, actors: ["theo"], viewerHasReacted: false }],
      });
      expect(issue.comments).toEqual([
        {
          id: "7",
          author: { login: "julius", name: null, avatarUrl: null },
          body: "Repro attached.",
          createdAt: "2026-07-02T00:00:00Z",
          url: null,
          reactions: [{ content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true }],
        },
      ]);
      // System notes become events; label notes are dropped in favour of the label events.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["closed", null],
      ]);
      // A closing merge request is not repeated as a related one.
      expect(
        issue.linkedPullRequests.map((link) => [link.number, link.closesIssue, link.isDraft]),
      ).toEqual([
        [50, true, false],
        [51, false, true],
      ]);
    }),
  );

  it.effect("marks a full native label-event page as partial before skipping unknown events", () =>
    Effect.gen(function* () {
      const api = yield* tracker((args) =>
        args[1]!.includes("resource_label_events")
          ? encode(
              Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                action: "unknown",
                created_at: "2026-07-01T00:00:00Z",
              })),
            )
          : answer(args[1]!),
      );
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
      });
      expect(issue.commentsCursor).toBeNull();
      expect(issue.historyTruncated).toBe(true);
      expect(issue.events).toHaveLength(1);
    }),
  );

  it.effect("pages a listing by GitLab's page number and stops on a short page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((args) => {
        paths.push(args[1]!);
        return encode([ISSUE]);
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        state: "open",
        involvement: "assigned",
        viewer: "julius",
        limit: 1,
        cursor: "3",
      });
      expect(paths[0]).toBe(
        "projects/acme%2Fweb/issues?state=opened&assignee_username=julius&order_by=updated_at&sort=desc&per_page=1&page=3",
      );
      expect(page.items[0]?.key).toBe("42");
      expect(page.nextCursor).toBe("4");
    }),
  );

  it.effect("refuses a key that names no GitLab issue without a request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const api = yield* tracker(() => {
        requests += 1;
        return "{}";
      });
      const error = yield* Effect.flip(
        api.getIssue({ cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "ENG-42" }),
      );
      expect(error.reason).toBe("not-found");
      expect(requests).toBe(0);
    }),
  );
});
