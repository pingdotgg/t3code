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
        stderr:
          'HTTP/1.1 200\nlink: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/comments?page=2>; rel="next"\n',
      };
    case "repos/acme/web/issues/comments/7/reactions":
      return {
        stdout: encode([
          { content: "+1", user: { login: "julius" } },
          { content: "+1", user: { login: "theo" } },
        ]),
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
        readonly stdoutTruncated?: boolean;
      }
    | ForgejoCli.ForgejoCliError,
) {
  return ForgejoIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          const result = onApi(input);
          if (isForgejoCliError(result)) return Effect.fail(result);
          const { stdout, stderr, stdoutTruncated } = result;
          return Effect.succeed({
            ...TestSourceControlHost.processOutput(stdout, { stderr: stderr ?? "" }),
            stdoutTruncated: stdoutTruncated ?? false,
          });
        },
      }),
    ),
  );
}

describe("ForgejoIssueTracker", () => {
  it.effect.each(["create", "update"] as const)(
    "applies an uppercase native template label on %s without extra reads",
    (operation) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method || input.path === "repos/acme/web/issues/42")
            return { stdout: encode(ISSUE) };
          if (input.path.endsWith("/issue_templates"))
            return {
              stdout: encode([
                { file_name: "bug.md", name: "Bug", content: "Steps", labels: ["BUG"] },
              ]),
            };
          if (input.path.endsWith("/issue_config")) return { stdout: "{}" };
          return { stdout: encode(input.path.startsWith("repos/") ? ISSUE.labels : []) };
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const template = (yield* api.listTemplates!(target)).templates[0]!;
        expect(template.labels).toEqual(["BUG"]);
        requests.length = 0;
        if (operation === "create")
          yield* api.create!({
            ...target,
            title: "Bug",
            body: template.body,
            labels: template.labels,
            assignees: [],
          });
        else yield* api.update!({ ...target, labels: template.labels });
        expect(requests.filter((request) => request.method)).toMatchObject([
          { body: { labels: [3] } },
        ]);
        expect(requests).toHaveLength(2);
      }),
  );

  it.effect.each([
    { requested: "BUG", native: "bug", source: "repo", matches: true },
    { requested: "BUG", native: "bug", source: "retained", matches: true },
    { requested: "BUG", native: "bug", source: "org", matches: true },
    { requested: "Σ", native: "ς", source: "repo", matches: true },
    { requested: "S", native: "ſ", source: "repo", matches: true },
    { requested: "K", native: "k", source: "repo", matches: true },
    { requested: "BUG[1].*", native: "bug[1].*", source: "org", matches: true },
    { requested: "BUG[1].*", native: "bug1-other", source: "repo", matches: false },
    { requested: "BUG", native: "bug\n", source: "repo", matches: false },
    { requested: "BUG", native: "bug\r", source: "org", matches: false },
    { requested: "BUG", native: "bug\u2028", source: "retained", matches: false },
    { requested: "BUG", native: "bug\u2029", source: "repo", matches: false },
    { requested: "SS", native: "ß", source: "retained", matches: false },
    { requested: "İ", native: "i", source: "org", matches: false },
  ])(
    "matches label $requested with native $native from $source: $matches",
    ({ requested, native, source, matches }) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const label = { id: 93, name: native };
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method) return { stdout: encode({ ...ISSUE, labels: [label] }) };
          if (input.path === "repos/acme/web/issues/42")
            return { stdout: encode({ ...ISSUE, labels: [label] }) };
          return {
            stdout: encode(
              (source === "repo" && input.path.startsWith("repos/")) ||
                (source === "org" && input.path.startsWith("orgs/"))
                ? [label]
                : [],
            ),
          };
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const mutation =
          source === "retained"
            ? api.update!({ ...target, labels: [requested] })
            : api.create!({
                ...target,
                title: "Bug",
                body: "",
                labels: [requested],
                assignees: [],
              });
        if (matches) yield* mutation;
        else expect(yield* Effect.flip(mutation)).toMatchObject({ reason: "failed" });
        expect(requests.filter((request) => request.method)).toMatchObject(
          matches ? [{ body: { labels: [93] } }] : [],
        );
        expect(requests).toHaveLength(
          source === "retained" || (source === "org" && matches) ? 3 : 2,
        );
      }),
  );

  it.effect.each(
    [
      { path: "/Acme/Web/issues/42", allowed: true },
      { path: "/api/v1/repos/Acme/Web/issues/42", allowed: true },
      { path: "/Mount/Acme/Web/issues/42", mount: "Mount/", allowed: true },
      { path: "/Mount/api/v1/repos/Acme/Web/issues/42", mount: "Mount/", allowed: true },
      { path: "/Acme/Web/issues/42", host: "other.test:3000", allowed: false },
      { path: "/Acme/Web/issues/42", host: "forgejo.test:3001", allowed: false },
      { path: "/Acme/Other/issues/42", allowed: false },
      { path: "/Other/Web/issues/42", allowed: false },
      { path: "/Acme/Web/issues/41", allowed: false },
      { path: "/Acme/Web/issues/42", id: 8, allowed: false },
      { path: "/other/Acme/Web/issues/42", mount: "Mount/", allowed: false },
      { path: "/mount/Acme/Web/issues/42", mount: "Mount/", allowed: false },
      { path: "/Mount/api/v1/Repos/Acme/Web/issues/42", mount: "Mount/", allowed: false },
      { path: "/Acme/Web/Issues/42", allowed: false },
      { path: "/Acme/Web/issues/42", protocol: "ftp", allowed: false },
    ].flatMap((test) => [true, false].map((reacted) => ({ ...test, reacted }))),
  )(
    "checks canonical comment membership for $path reacted=$reacted",
    ({
      path,
      host = "forgejo.test:3000",
      mount = "",
      id = 7,
      protocol = "https",
      allowed,
      reacted,
    }) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return { stdout: encode({ id, issue_url: `${protocol}://${host}${path}` }) };
        });
        const target = {
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: `${mount}acme/web`,
          key: "42",
        };
        const mutation = api.setReaction!({
          ...target,
          subjectId: "7",
          content: "thumbs-up",
          reacted,
        });
        if (allowed) yield* mutation;
        else expect(yield* Effect.flip(mutation)).toMatchObject({ reason: "failed" });
        expect(requests).toHaveLength(allowed ? 2 : 1);
        expect(requests[0]).toMatchObject({ path: `repos/${target.scope}/issues/comments/7` });
        expect(requests[0]?.method).toBeUndefined();
        if (allowed)
          expect(requests[1]).toMatchObject({
            path: `repos/${target.scope}/issues/comments/7/reactions`,
            method: reacted ? "POST" : "DELETE",
            body: { content: "+1" },
          });
        else expect(requests.every((request) => request.method === undefined)).toBe(true);
      }),
  );

  it.effect.each([
    { reacted: true, method: "POST", issueUrl: "https://forgejo.test:3000/acme/web/issues/42" },
    {
      reacted: false,
      method: "DELETE",
      issueUrl: "https://forgejo.test:3000/api/v1/repos/acme/web/issues/42",
    },
    {
      reacted: true,
      method: "POST",
      issueUrl: "https://forgejo.test:3000/forgejo/acme/web/issues/42",
    },
    {
      reacted: true,
      method: "POST",
      scope: "forgejo/maria/project",
      issueUrl: "https://forgejo.test:3000/forgejo/maria/project/issues/42",
    },
    {
      reacted: false,
      method: "DELETE",
      scope: "forgejo/maria/project",
      issueUrl: "https://forgejo.test:3000/forgejo/api/v1/repos/maria/project/issues/42",
    },
  ])(
    "checks comment ownership before $method reaction",
    ({ reacted, method, issueUrl, scope = "acme/web" }) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return {
            stdout: encode({ id: 7, issue_url: issueUrl }),
          };
        });
        yield* api.setReaction!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope,
          key: "42",
          subjectId: "7",
          content: "thumbs-up",
          reacted,
        });
        expect(requests).toMatchObject([
          { path: `repos/${scope}/issues/comments/7` },
          { path: `repos/${scope}/issues/comments/7/reactions`, method, body: { content: "+1" } },
        ]);
        expect(requests[0]?.method).toBeUndefined();
      }),
  );

  it.effect.each([
    { issue_url: "https://forgejo.test:3000/acme/web/issues/41" },
    { issue_url: "https://forgejo.test:3000/acme/other/issues/42" },
    { issue_url: "https://other.test:3000/acme/web/issues/42" },
    { issue_url: "https://forgejo.test/acme/web/issues/42" },
    { issue_url: "https://forgejo.test:3000/acme/web/pulls/42" },
    { issue_url: "not a URL" },
    { issue_url: "" },
    {},
    { id: 8, issue_url: "https://forgejo.test:3000/acme/web/issues/42" },
    { issue_url: "https://forgejo.test:3000/acme/web/issues/42", stdoutTruncated: true },
  ])("refuses comment reactions when native ownership is wrong or unknown: %s", (ownership) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return {
          stdout: encode({ id: 7, ...ownership }),
          stdoutTruncated: "stdoutTruncated" in ownership && ownership.stdoutTruncated,
        };
      });
      for (const reacted of [true, false]) {
        yield* Effect.flip(
          api.setReaction!({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
            subjectId: "7",
            content: "thumbs-up",
            reacted,
          }),
        );
      }
      expect(requests.map((input) => input.path)).toEqual([
        "repos/acme/web/issues/comments/7",
        "repos/acme/web/issues/comments/7",
      ]);
      expect(requests.every((input) => input.method === undefined)).toBe(true);
    }),
  );

  it.effect.each([true, false])("keeps whole-issue reactions at one write: reacted=%s", (reacted) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return { stdout: "{}" };
      });
      yield* api.setReaction!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        content: "thumbs-up",
        reacted,
      });
      expect(requests).toMatchObject([
        {
          path: "repos/acme/web/issues/42/reactions",
          method: reacted ? "POST" : "DELETE",
          body: { content: "+1" },
        },
      ]);
    }),
  );

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
        state: { category: "open", name: "open" },
        author: { login: "octocat", name: "Octo Cat", avatarUrl: null },
        createdAt: "2026-06-30T22:00:00.000Z",
        labels: [{ name: "bug", color: "d73a4a" }],
        viewer: "julius",
        viewerPermissions: {
          setState: true,
          comment: true,
          edit: true,
          labels: true,
          assignees: true,
        },
        reactions: [{ content: "eyes", count: 1, actors: ["theo"], viewerHasReacted: false }],
        reactionsTruncated: true,
        commentsCursor: "2",
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
      ]);
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
      ]);
    }),
  );

  it.effect.each([false, true])(
    "marks native issue reaction page partial only when needed: %s",
    (partial) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          if (input.path.startsWith("repos/acme/web/issues/42/reactions"))
            return {
              stdout: encode(
                partial
                  ? Array.from({ length: 50 }, (_, index) => ({
                      content: "eyes",
                      user: { login: `user${index}` },
                    }))
                  : [{ content: "eyes", user: { login: "julius" } }],
              ),
              stderr: partial
                ? 'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/reactions?page=2>; rel="next"'
                : 'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/reactions?page=1>; rel="last"',
            };
          return answer(input.path);
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        });
        expect(issue.reactionsTruncated).toBe(partial);
        expect(issue.reactions).toMatchObject([
          { content: "eyes", count: partial ? 50 : 1, viewerHasReacted: !partial },
        ]);
        expect(
          paths.filter((path) => path.startsWith("repos/acme/web/issues/42/reactions")),
        ).toEqual(["repos/acme/web/issues/42/reactions?limit=50&page=1"]);
      }),
  );

  it.effect("keeps unknown issue-unit controls available without using code push permission", () =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => answer(input.path));
      expect(
        yield* api.getViewerPermissions({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        }),
      ).toEqual({ setState: true, comment: true, edit: true, labels: true, assignees: true });
    }),
  );

  it.effect("reads only the repository to determine issue permissions", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return answer(input.path);
      });
      yield* api.getViewerPermissions({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      expect(paths).toEqual(["repos/acme/web"]);
    }),
  );

  it.effect.each([
    { name: "a non-admin issue writer with code read access", denied: false },
    { name: "a reader refused by native issue permissions", denied: true },
  ])("lets the native API decide locked commenting for $name", ({ denied }) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const detail = "Native issue permissions denied this comment.";
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.method === "POST")
          return denied
            ? new ForgejoCli.ForgejoCliError({
                command: "tea",
                cwd: "/w",
                reason: "forbidden",
                httpStatus: 403,
                detail,
              })
            : {
                stdout: encode({
                  id: 8,
                  body: "A comment",
                  user: { login: "julius" },
                  created_at: "2026-07-04T00:00:00Z",
                }),
                stderr: "HTTP/1.1 201 Created",
              };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      expect((yield* api.getViewerPermissions(target)).comment).toBe(true);
      const write = api.comment!({ ...target, body: "A comment" });
      if (denied) expect(yield* Effect.flip(write)).toMatchObject({ reason: "failed", detail });
      else yield* write;
      expect(requests).toHaveLength(2);
      expect(requests.filter((request) => request.method === "POST")).toEqual([
        {
          cwd: "/w",
          host: "forgejo.test:3000",
          repository: "acme/web",
          path: "repos/acme/web/issues/42/comments",
          method: "POST",
          body: { body: "A comment" },
        },
      ]);
    }),
  );

  it.effect.each([{ archived: true }, { has_issues: false }])(
    "disables issue controls for native repository restriction %s",
    (restriction) =>
      Effect.gen(function* () {
        const api = yield* tracker((input) =>
          input.path === "repos/acme/web"
            ? {
                stdout: encode({
                  full_name: "acme/web",
                  permissions: { push: true, admin: false },
                  ...restriction,
                }),
              }
            : answer(input.path),
        );
        expect(
          yield* api.getViewerPermissions({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
          }),
        ).toEqual({
          setState: false,
          comment: false,
          edit: false,
          labels: false,
          assignees: false,
        });
      }),
  );

  it.effect(
    "resolves linked pull requests by native repository and number on the configured host",
    () =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const references = [
          ["acme/web", 50],
          ["other/repo", 50],
          ["other/repo", 50],
          ["foreign/repo", 60],
        ] as const;
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const route = input.path.split("?")[0]!;
          if (route === "repos/acme/web/issues/42/timeline")
            return {
              stdout: encode(
                references.map(([repository, number], index) => ({
                  id: index + 1,
                  type: "pull_ref",
                  created_at: "2026-07-02T00:00:00Z",
                  ref_issue: {
                    number,
                    html_url: `https://${repository === "foreign/repo" ? "other.test" : "forgejo.test:3000"}/${repository}/pulls/${number}`,
                    pull_request: { merged: false },
                  },
                })),
              ),
            };
          if (route === "repos/other/repo/pulls/50")
            return {
              stdout: encode({
                number: 50,
                title: "Other project fix",
                html_url: "https://forgejo.test:3000/other/repo/pulls/50",
                state: "closed",
                merged: true,
              }),
            };
          return answer(input.path);
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        });
        expect(
          issue.linkedPullRequests.map((pull) => [pull.repository, pull.number, pull.state]),
        ).toEqual([
          ["acme/web", 50, "open"],
          ["other/repo", 50, "merged"],
        ]);
        expect(paths.filter((path) => path.includes("/pulls/"))).toEqual([
          "repos/acme/web/pulls/50",
          "repos/other/repo/pulls/50",
        ]);
      }),
  );

  it.effect.each(["mount-a/acme/web", "acme/web"])(
    "keeps linked pull request installation identity for scope %s",
    (scope) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const urls = [
          "https://forgejo.test:3000/mount-a/acme/web/pulls/50",
          "https://forgejo.test:3000/mount-b/acme/web/pulls/50",
          "https://forgejo.test:3000/mount-a/other/repo/pulls/50",
          "https://forgejo.test:3000/mount-b/other/repo/pulls/50",
        ];
        const api = yield* tracker((input) => {
          requests.push(input);
          const route = input.path.split("?")[0]!;
          if (route === `repos/${scope}/issues/42`)
            return {
              stdout: encode({
                ...ISSUE,
                html_url: "https://forgejo.test:3000/mount-a/acme/web/issues/42",
              }),
            };
          if (route === `repos/${scope}/issues/42/timeline`)
            return {
              stdout: encode(
                [
                  ...urls,
                  urls[1]!,
                  "https://other.test/mount-a/acme/web/pulls/50",
                  "invalid",
                  "https://forgejo.test:3000/mount-a/acme/web/pulls/51",
                ].map((url, index) => ({
                  id: index + 1,
                  type: "pull_ref",
                  created_at: "2026-07-02T00:00:00Z",
                  ref_issue: { number: 50, html_url: url, pull_request: { merged: false } },
                })),
              ),
            };
          if (route.includes("/pulls/")) {
            const other = route.includes("other/repo");
            return {
              stdout: encode({
                number: 50,
                title: other ? "Other A fix" : "A fix",
                html_url: urls[other ? 2 : 0],
                state: "closed",
                merged: true,
              }),
            };
          }
          return answer(input.path.replace(`repos/${scope}`, "repos/acme/web"));
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope,
          key: "42",
        });
        expect(issue.linkedPullRequests).toMatchObject([
          {
            repository: "mount-a/acme/web",
            number: 50,
            title: "A fix",
            url: urls[0],
            state: "merged",
          },
          {
            repository: "mount-b/acme/web",
            number: 50,
            title: "#50",
            url: urls[1],
            state: null,
            isDraft: false,
          },
          {
            repository: "mount-a/other/repo",
            number: 50,
            title: "Other A fix",
            url: urls[2],
            state: "merged",
          },
          {
            repository: "mount-b/other/repo",
            number: 50,
            title: "#50",
            url: urls[3],
            state: null,
            isDraft: false,
          },
        ]);
        expect(requests.filter((request) => request.path.includes("/pulls/"))).toEqual([
          {
            cwd: "/w",
            host: "forgejo.test:3000",
            repository: "mount-a/acme/web",
            path: "repos/mount-a/acme/web/pulls/50",
          },
          {
            cwd: "/w",
            host: "forgejo.test:3000",
            repository: "mount-a/other/repo",
            path: "repos/mount-a/other/repo/pulls/50",
          },
        ]);
      }),
  );

  it.effect("marks native timeline continuation without walking its next page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const result = answer(input.path);
        return input.path.includes("/timeline")
          ? {
              ...result,
              stderr:
                'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/timeline?page=2>; rel="next"',
            }
          : result;
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
      });
      expect(issue.historyTruncated).toBe(true);
      expect(paths.filter((path) => path.includes("/timeline"))).toHaveLength(1);
    }),
  );

  it.effect.each(["create", "update"] as const)(
    "refuses unresolved label names before %s writes",
    (operation) =>
      Effect.gen(function* () {
        const writes: string[] = [];
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          if (input.method) {
            writes.push(input.path);
            return { stdout: encode(ISSUE) };
          }
          if (
            input.path.startsWith("repos/acme/web/labels") ||
            input.path.startsWith("orgs/acme/labels")
          )
            return {
              stdout: encode([{ id: 12, name: "bug" }]),
              stderr: 'Link: <https://forgejo.test/labels?page=2>; rel="next"',
            };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const error = yield* Effect.flip(
          operation === "create"
            ? api.create!({
                ...target,
                title: "New issue",
                body: "",
                labels: ["12", "later"],
                assignees: [],
              })
            : api.update!({ ...target, title: "Changed title", labels: ["12", "later"] }),
        );
        expect(error.detail).toContain("label");
        expect(writes).toEqual([]);
        expect(paths).toHaveLength(operation === "create" ? 2 : 3);
        expect(paths.some((path) => path.includes("page=2"))).toBe(false);
      }),
  );

  it.effect.each([
    { labels: ["Old", "bug", "enhancement", "Old"], ids: [90, 3, 4] },
    { labels: ["bug", "enhancement"], ids: [3, 4] },
    { labels: [], ids: [] },
  ])("replaces labels without losing retained organization labels: $labels", ({ labels, ids }) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        if (input.method) return { stdout: "[]" };
        if (input.path.startsWith("repos/acme/web/labels"))
          return {
            stdout: encode([
              { id: 3, name: "bug" },
              { id: 4, name: "enhancement" },
            ]),
          };
        if (input.path === "repos/acme/web/issues/42")
          return {
            stdout: encode({ ...ISSUE, labels: [...ISSUE.labels, { id: 90, name: "Old" }] }),
          };
        throw new Error(`unexpected path ${input.path}`);
      });
      yield* api.update!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        labels,
      });
      expect(requests.filter((input) => input.method)).toMatchObject([
        { path: "repos/acme/web/issues/42/labels", method: "PUT", body: { labels: ids } },
      ]);
      expect(requests).toHaveLength(labels.includes("Old") ? 3 : labels.length ? 2 : 1);
    }),
  );

  it.effect.each(["create", "update"] as const)(
    "offers and resolves one native organization label page for %s",
    (operation) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method)
            return {
              stdout: encode({
                ...ISSUE,
                labels: [
                  { id: 3, name: "bug" },
                  { id: 91, name: "Org" },
                ],
              }),
            };
          if (input.path.startsWith("repos/acme/web/labels"))
            return {
              stdout: encode(ISSUE.labels),
              stderr: 'Link: <https://forgejo.test/labels?page=1>; rel="last"',
            };
          if (input.path.startsWith("orgs/acme/labels"))
            return {
              stdout: encode([
                { id: 91, name: "Org" },
                { id: 99, name: "bug", color: "ffffff" },
              ]),
              stderr: 'Link: <https://forgejo.test/labels?page=2>; rel="next"',
            };
          if (input.path.startsWith("repos/acme/web/assignees")) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        expect(yield* api.listCandidates!(target)).toMatchObject({
          labels: [{ name: "bug", color: "d73a4a" }, { name: "Org" }],
          truncated: true,
        });
        expect(requests.map((input) => input.path)).toContain("orgs/acme/labels?limit=50&page=1");
        requests.length = 0;
        if (operation === "create")
          yield* api.create!({
            ...target,
            title: "New issue",
            body: "",
            labels: ["bug", "Org"],
            assignees: [],
          });
        else yield* api.update!({ ...target, labels: ["bug", "Org"] });
        expect(requests.filter((input) => input.method)).toMatchObject([
          { body: { labels: [3, 91] } },
        ]);
        expect(requests.filter((input) => input.path.startsWith("orgs/"))).toHaveLength(1);
        expect(requests).toHaveLength(operation === "create" ? 3 : 4);
      }),
  );

  it.effect.each(["not-found", "rate-limit"] as const)(
    "keeps repository candidates only for absent organization API, not %s failures",
    (reason) =>
      Effect.gen(function* () {
        const api = yield* tracker((input) => {
          if (input.path.startsWith("orgs/acme/labels"))
            return new ForgejoCli.ForgejoCliError({
              command: "tea",
              cwd: "/w",
              reason,
              detail: "Organization labels unavailable.",
            });
          if (input.path.startsWith("repos/acme/web/labels"))
            return { stdout: encode(ISSUE.labels) };
          if (input.path.startsWith("repos/acme/web/assignees")) return { stdout: "[]" };
          throw new Error(`unexpected path ${input.path}`);
        });
        const result = api.listCandidates!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
        });
        if (reason === "not-found")
          expect(yield* result).toMatchObject({ labels: [{ name: "bug" }], truncated: true });
        else expect(yield* Effect.flip(result)).toMatchObject({ reason: "rate-limited" });
      }),
  );

  it.effect.each(["create", "update"] as const)(
    "uses the native organization owner for mounted %s and candidates",
    (operation) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          if (input.method)
            return { stdout: encode({ ...ISSUE, labels: [{ id: 91, name: "Org" }] }) };
          if (input.path.startsWith("orgs/maria/labels"))
            return { stdout: encode([{ id: 91, name: "Org" }]) };
          if (input.path === "repos/forgejo/maria/project/issues/42")
            return { stdout: encode(ISSUE) };
          if (
            input.path.startsWith("repos/forgejo/maria/project/labels") ||
            input.path.startsWith("repos/forgejo/maria/project/assignees")
          )
            return { stdout: "[]" };
          throw new Error(`unexpected path ${input.path}`);
        });
        const target = {
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "forgejo/maria/project",
          key: "42",
        };
        expect(yield* api.listCandidates!(target)).toMatchObject({ labels: [{ name: "Org" }] });
        requests.length = 0;
        if (operation === "create")
          yield* api.create!({ ...target, title: "New", body: "", labels: ["Org"], assignees: [] });
        else yield* api.update!({ ...target, labels: ["Org"] });
        expect(requests.filter((request) => request.path.startsWith("orgs/"))).toMatchObject([
          { path: "orgs/maria/labels?limit=50&page=1" },
        ]);
        expect(requests.filter((request) => request.method)).toMatchObject([
          { body: { labels: [91] } },
        ]);
        expect(requests).toHaveLength(operation === "create" ? 3 : 4);
      }),
  );

  it.effect.each([
    "https://forgejo.test:3000/forgejo/maria/other/issues/42",
    "https://forgejo.test:3000/forgejo/maria/project/issues/41",
    "https://other.test:3000/forgejo/maria/project/issues/42",
    "https://forgejo.test:3000/other/maria/project/issues/42",
    "https://forgejo.test:3000/other/api/v1/repos/maria/project/issues/42",
  ])("refuses mounted reaction owner mismatch: %s", (issue_url) =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return { stdout: encode({ id: 7, issue_url }) };
      });
      yield* Effect.flip(
        api.setReaction!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "forgejo/maria/project",
          key: "42",
          subjectId: "7",
          content: "thumbs-up",
          reacted: true,
        }),
      );
      expect(requests).toMatchObject([{ path: "repos/forgejo/maria/project/issues/comments/7" }]);
      expect(requests[0]?.method).toBeUndefined();
    }),
  );

  it.effect.each([
    "repos/acme/web/labels?limit=50",
    "repos/acme/web/issues/42",
    "orgs/acme/labels?limit=50&page=1",
  ])("refuses truncated label resolution response at %s before changing any fields", (path) =>
    Effect.gen(function* () {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        if (input.method) writes.push(input);
        const response =
          input.path === "repos/acme/web/issues/42"
            ? { stdout: encode(ISSUE) }
            : { stdout: encode([{ id: 92, name: "Org" }]) };
        return input.path === path ? { ...response, stdoutTruncated: true } : response;
      });
      const error = yield* Effect.flip(
        api.update!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
          title: "Changed",
          labels: ["Old"],
        }),
      );
      expect(error.detail).toContain("output limit");
      expect(writes).toEqual([]);
    }),
  );

  it.effect("maps a numeric native label name to its actual mutation ID", () =>
    Effect.gen(function* () {
      const writes: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        if (input.path.startsWith("repos/acme/web/labels"))
          return {
            stdout: encode([
              { id: 93, name: "12" },
              { id: 12, name: "bug" },
            ]),
          };
        if (input.method) {
          writes.push(input);
          return { stdout: encode(ISSUE) };
        }
        return answer(input.path);
      });
      yield* api.create!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        title: "New issue",
        body: "",
        labels: ["12"],
        assignees: [],
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]?.body).toMatchObject({ labels: [93] });
    }),
  );

  it.effect.each([{ assignees: ["julius"] }, { assignees: [] }] as const)(
    "reports native success with ignored assignee set %s as a failed update",
    ({ assignees }) =>
      Effect.gen(function* () {
        const writes: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          writes.push(input);
          return { stdout: encode(ISSUE), stderr: "HTTP/1.1 201 Created" };
        });
        const error = yield* Effect.flip(
          api.update!({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            key: "42",
            assignees,
          }),
        );
        expect(error.detail).toContain("assignees");
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ method: "PATCH", body: { assignees: [...assignees] } });
      }),
  );

  it.effect.each(["labels", "assignees"] as const)(
    "keeps the created issue and warns when native success skips selected %s",
    (field) =>
      Effect.gen(function* () {
        const requests: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          requests.push(input);
          return input.method === "POST"
            ? {
                stdout: encode({ ...ISSUE, labels: [], assignees: [] }),
                stderr: "HTTP/1.1 201 Created",
              }
            : { stdout: encode([{ id: 3, name: "bug" }]) };
        });
        const result = yield* api.create!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          title: "New issue",
          body: "",
          labels: field === "labels" ? ["bug"] : [],
          assignees: field === "assignees" ? ["julius"] : [],
        });
        expect(result).toMatchObject({ key: "42", displayKey: "#42", url: ISSUE.html_url });
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings?.[0]).toContain(field);
        expect(requests).toHaveLength(field === "labels" ? 2 : 1);
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
        expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
          assignees: field === "assignees" ? ["julius"] : [],
        });
      }),
  );

  it.effect("returns no create warnings when native labels and assignees match", () =>
    Effect.gen(function* () {
      const requests: ForgejoCli.ForgejoApiInput[] = [];
      const api = yield* tracker((input) => {
        requests.push(input);
        return input.method === "POST"
          ? { stdout: encode({ ...ISSUE, assignees: [{ login: "theo" }, { login: "julius" }] }) }
          : { stdout: encode([{ id: 3, name: "bug" }]) };
      });
      const result = yield* api.create!({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        title: "New issue",
        body: "",
        labels: ["bug"],
        assignees: ["julius", "THEO"],
      });
      expect(result.warnings ?? []).toEqual([]);
      expect(requests).toHaveLength(2);
      expect(requests.find((request) => request.method === "POST")?.body).toMatchObject({
        assignees: ["julius", "THEO"],
      });
    }),
  );

  it.effect.each([{ assignees: ["julius", "THEO"] }, { assignees: [] }] as const)(
    "accepts an applied native assignee set %s independent of order and username case",
    ({ assignees }) =>
      Effect.gen(function* () {
        const writes: ForgejoCli.ForgejoApiInput[] = [];
        const api = yield* tracker((input) => {
          writes.push(input);
          return {
            stdout: encode({
              ...ISSUE,
              assignees: assignees.length ? [{ login: "theo" }, { login: "julius" }] : [],
            }),
          };
        });
        yield* api.update!({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
          assignees,
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]?.body).toMatchObject({ assignees: [...assignees] });
      }),
  );

  it.effect.each([
    undefined,
    'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/timeline?page=1>; rel="first"',
  ])(
    "marks a filtered native timeline page as partial unless its Link header proves completion %s",
    (stderr) =>
      Effect.gen(function* () {
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          if (input.path.includes("/timeline"))
            return {
              stdout: encode(
                Array.from({ length: 49 }, (_, index) => ({
                  id: index + 1,
                  type: "label",
                  label: { id: 3, name: "bug" },
                  created_at: "2026-07-01T00:00:00Z",
                })),
              ),
              ...(stderr === undefined ? {} : { stderr }),
            };
          return answer(input.path);
        });
        const issue = yield* api.getIssue({
          cwd: "/w",
          host: "forgejo.test:3000",
          scope: "acme/web",
          key: "42",
        });
        expect(issue.historyTruncated).toBe(stderr === undefined);
        expect(paths.filter((path) => path.includes("/timeline"))).toHaveLength(1);
      }),
  );

  it.effect("honors a smaller requested issue page", () =>
    Effect.gen(function* () {
      const api = yield* tracker((input) => {
        expect(new URL(input.path, "https://forgejo.test").searchParams.get("limit")).toBe("3");
        return { stdout: encode([ISSUE]), stderr: 'Link: </next>; rel="next"' };
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "forgejo.test",
        scope: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "julius",
        limit: 3,
      });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBe("2");
    }),
  );

  it.effect("lists issues by page and leaves pull requests out of the rows", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        return {
          stdout: encode([
            ISSUE,
            ...Array.from({ length: 49 }, (_, index) => ({
              ...ISSUE,
              number: 43 + index,
              pull_request: { merged: false },
            })),
          ]),
        };
      });
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        state: "open",
        involvement: "authored",
        viewer: "julius",
        limit: 50,
        cursor: "2",
      });
      expect(paths).toEqual([
        "repos/acme/web/issues?type=issues&state=open&sort=recentupdate&created_by=julius&limit=50&page=2",
      ]);
      expect(page.items.map((item) => item.key)).toEqual(["42"]);
      // No `Link` header at all means the server may still have more; a full page carries on.
      expect(page.nextCursor).toBe("3");
    }),
  );

  it.effect.each([51, 60])(
    "slices an unpaged Gitea response with %s comments without repeats",
    (count) =>
      Effect.gen(function* () {
        const comments = Array.from({ length: count }, (_, index) => ({
          id: index + 1,
          body: `Comment ${index + 1}`,
          user: { login: "julius" },
          created_at: "2026-07-02T00:00:00Z",
        }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const route = input.path.split("?")[0]!;
          if (route === "repos/acme/web/issues/42/comments")
            return { stdout: encode(comments), stderr: `X-Total-Count: ${count}` };
          if (/\/issues\/comments\/\d+\/reactions$/.test(route)) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const first = yield* api.getIssue(target);
        expect(first.comments.map((comment) => comment.id)).toEqual(
          Array.from({ length: 50 }, (_, index) => String(index + 1)),
        );
        expect(first.commentsCursor).toBe("offset:1:50");
        const second = yield* api.getComments({ ...target, cursor: first.commentsCursor! });
        expect(second.comments.map((comment) => comment.id)).toEqual(
          comments.slice(50).map((comment) => String(comment.id)),
        );
        expect(second.nextCursor).toBe(`page:2:${count}`);
        const last = yield* api.getComments({ ...target, cursor: second.nextCursor! });
        expect(last.comments).toEqual([]);
        expect(last.nextCursor).toBeNull();
        expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual([
          "repos/acme/web/issues/42/comments?limit=50&page=1",
          "repos/acme/web/issues/42/comments?limit=50&page=1",
          "repos/acme/web/issues/42/comments?limit=50&page=2",
        ]);
        expect(paths.filter((path) => path.endsWith("/comments/51/reactions"))).toHaveLength(1);
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(count);
      }),
  );

  it.effect.each([60, 110])(
    "continues after every offset slice of a headerless native page with %s comments",
    (firstCount) =>
      Effect.gen(function* () {
        const comments = Array.from({ length: firstCount + 60 }, (_, index) => ({
          id: index + 1,
          body: `Comment ${index + 1}`,
          user: { login: "julius" },
          created_at: "2026-07-02T00:00:00Z",
        }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const [route, query] = input.path.split("?");
          if (route === "repos/acme/web/issues/42/comments") {
            const page = Number(new URLSearchParams(query).get("page"));
            return {
              stdout: encode(
                page === 1
                  ? comments.slice(0, firstCount)
                  : page === 2
                    ? comments.slice(firstCount)
                    : [],
              ),
            };
          }
          if (/\/issues\/comments\/\d+\/reactions$/.test(route!)) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        const first = yield* api.getIssue(target);
        const ids = first.comments.map((comment) => comment.id);
        expect(ids).toEqual(comments.slice(0, 50).map((comment) => String(comment.id)));
        let cursor = first.commentsCursor;
        const pages = [...Array.from({ length: Math.ceil(firstCount / 50) - 1 }, () => 1), 2, 2, 3];
        for (const page of pages) {
          expect(cursor).not.toBeNull();
          const result = yield* api.getComments({ ...target, cursor: cursor! });
          expect(result.comments.length).toBeLessThanOrEqual(50);
          ids.push(...result.comments.map((comment) => comment.id));
          cursor = result.nextCursor;
          expect(paths.findLast((path) => /\/42\/comments(?:\?|$)/.test(path))).toBe(
            `repos/acme/web/issues/42/comments?limit=50&page=${page}`,
          );
        }
        expect(cursor).toBeNull();
        expect(ids).toEqual(comments.map((comment) => String(comment.id)));
        expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual(
          [1, ...pages].map((page) => `repos/acme/web/issues/42/comments?limit=50&page=${page}`),
        );
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(comments.length);
      }),
  );

  it.effect("keeps the native page while slicing an oversized later comment page", () =>
    Effect.gen(function* () {
      const pages: number[] = [];
      const api = yield* tracker((input) => {
        if (input.path.startsWith("repos/acme/web/issues/42/comments?")) {
          const page = Number(new URL(input.path, "https://forgejo.test").searchParams.get("page"));
          pages.push(page);
          const rows = Array.from({ length: page === 1 ? 1 : 60 }, (_, index) => ({
            id: page === 1 ? 1 : index + 2,
            body: "Comment",
            user: { login: "julius" },
            created_at: "2026-07-02T00:00:00Z",
          }));
          return {
            stdout: encode(rows),
            stderr: page === 1 ? 'Link: </next>; rel="next"' : 'Link: </previous>; rel="prev"',
          };
        }
        if (/\/issues\/comments\/\d+\/reactions$/.test(input.path)) return { stdout: "[]" };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test", scope: "acme/web", key: "42" };
      const first = yield* api.getIssue(target);
      const second = yield* api.getComments({ ...target, cursor: first.commentsCursor! });
      expect(second.nextCursor).toBe("offset:2:50");
      const third = yield* api.getComments({ ...target, cursor: second.nextCursor! });
      expect(third.comments.map((comment) => comment.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => String(index + 52)),
      );
      expect(third.nextCursor).toBeNull();
      expect(pages).toEqual([1, 2, 2]);
    }),
  );

  it.effect(
    "continues headerless issue pages below the requested size until a native empty page",
    () =>
      Effect.gen(function* () {
        const issues = Array.from({ length: 50 }, (_, index) => ({ ...ISSUE, number: index + 1 }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
          return { stdout: encode(issues.slice((page - 1) * 20, page * 20)) };
        });
        let cursor: string | undefined;
        const keys: string[] = [];
        for (let page = 1; page <= 4; page++) {
          const result = yield* api.listIssues({
            cwd: "/w",
            host: "forgejo.test:3000",
            scope: "acme/web",
            state: "open",
            involvement: "all",
            viewer: "julius",
            limit: 50,
            cursor,
          });
          keys.push(...result.items.map((issue) => issue.key));
          expect(result.nextCursor).toBe(page === 4 ? null : String(page + 1));
          expect(paths).toHaveLength(page);
          cursor = result.nextCursor ?? undefined;
        }
        expect(keys).toEqual(issues.map((issue) => String(issue.number)));
      }),
  );

  it.effect(
    "continues headerless comment pages below the requested size until a native empty page",
    () =>
      Effect.gen(function* () {
        const comments = Array.from({ length: 50 }, (_, index) => ({
          id: index + 1,
          body: `Comment ${index + 1}`,
          user: { login: "julius" },
          created_at: "2026-07-02T00:00:00Z",
        }));
        const paths: string[] = [];
        const api = yield* tracker((input) => {
          paths.push(input.path);
          const [route, query] = input.path.split("?");
          if (route === "repos/acme/web/issues/42/comments") {
            const page = Number(new URLSearchParams(query).get("page"));
            return { stdout: encode(comments.slice((page - 1) * 20, page * 20)) };
          }
          if (/\/issues\/comments\/\d+\/reactions$/.test(route!)) return { stdout: "[]" };
          return answer(input.path);
        });
        const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
        let cursor = "1";
        const ids: string[] = [];
        for (let page = 1; page <= 4; page++) {
          const result = yield* api.getComments({ ...target, cursor });
          ids.push(...result.comments.map((comment) => comment.id));
          expect(result.nextCursor).toBe(
            page === 4 ? null : `page:${page + 1}:${Math.min(page * 20, 50)}`,
          );
          expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(page);
          cursor = result.nextCursor ?? "";
        }
        expect(ids).toEqual(comments.map((comment) => String(comment.id)));
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(50);
      }),
  );

  it.effect("keeps native Forgejo page cursors and stops at a short final comment page", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const route = input.path.split("?")[0]!;
        if (route === "repos/acme/web/issues/42/comments")
          return {
            stdout: encode([
              {
                id: 51,
                body: "Last comment",
                user: { login: "julius" },
                created_at: "2026-07-02T00:00:00Z",
              },
            ]),
            stderr:
              'Link: <https://forgejo.test:3000/api/v1/repos/acme/web/issues/42/comments?page=1>; rel="prev"',
          };
        if (/\/issues\/comments\/\d+\/reactions$/.test(route)) return { stdout: "[]" };
        return answer(input.path);
      });
      const page = yield* api.getComments({
        cwd: "/w",
        host: "forgejo.test:3000",
        scope: "acme/web",
        key: "42",
        cursor: "2",
      });
      expect(page.comments.map((comment) => comment.id)).toEqual(["51"]);
      expect(page.nextCursor).toBeNull();
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual([
        "repos/acme/web/issues/42/comments?limit=50&page=2",
      ]);
    }),
  );

  it.effect.each([
    { name: "a headerless native page with ten later comments", count: 60, paginated: true },
    {
      name: "an exact full unpaged response that ignores the page argument",
      count: 50,
      paginated: false,
    },
    {
      name: "a short unpaged response that ignores the page argument",
      count: 20,
      paginated: false,
    },
  ])("continues a headerless comment page and stops correctly for $name", ({ count, paginated }) =>
    Effect.gen(function* () {
      const comments = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        body: `Comment ${index + 1}`,
        user: { login: "julius" },
        created_at: "2026-07-02T00:00:00Z",
      }));
      const paths: string[] = [];
      const api = yield* tracker((input) => {
        paths.push(input.path);
        const [route, query] = input.path.split("?");
        if (route === "repos/acme/web/issues/42/comments") {
          const page = Number(new URLSearchParams(query).get("page"));
          return {
            stdout: encode(paginated ? comments.slice((page - 1) * 50, page * 50) : comments),
          };
        }
        if (/\/issues\/comments\/\d+\/reactions$/.test(route!)) return { stdout: "[]" };
        return answer(input.path);
      });
      const target = { cwd: "/w", host: "forgejo.test:3000", scope: "acme/web", key: "42" };
      const first = yield* api.getIssue(target);
      expect(first.comments.map((comment) => comment.id)).toEqual(
        Array.from({ length: Math.min(count, 50) }, (_, index) => String(index + 1)),
      );
      expect(first.commentsCursor).toBe(`page:2:${Math.min(count, 50)}`);
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(1);
      const second = yield* api.getComments({ ...target, cursor: first.commentsCursor! });
      expect(second.comments.map((comment) => comment.id)).toEqual(
        paginated ? Array.from({ length: 10 }, (_, index) => String(index + 51)) : [],
      );
      expect(second.nextCursor).toBe(paginated ? "page:3:60" : null);
      expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toEqual([
        "repos/acme/web/issues/42/comments?limit=50&page=1",
        "repos/acme/web/issues/42/comments?limit=50&page=2",
      ]);
      expect(paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path))).toHaveLength(
        count,
      );
      if (paginated) {
        const last = yield* api.getComments({ ...target, cursor: second.nextCursor! });
        expect(last.comments).toEqual([]);
        expect(last.nextCursor).toBeNull();
        expect(paths.filter((path) => /\/42\/comments(?:\?|$)/.test(path))).toHaveLength(3);
        expect(
          paths.filter((path) => /\/issues\/comments\/\d+\/reactions$/.test(path)),
        ).toHaveLength(count);
      }
    }),
  );
});
