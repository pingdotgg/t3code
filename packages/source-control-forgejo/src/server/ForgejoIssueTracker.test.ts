import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoIssueTracker from "./ForgejoIssueTracker.ts";

const encode = (value: unknown) => JSON.stringify(value);

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
  onApi: (input: ForgejoCli.ForgejoApiInput) => {
    readonly stdout: string;
    readonly stderr?: string;
  },
) {
  return ForgejoIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          const { stdout, stderr } = onApi(input);
          return Effect.succeed(
            TestSourceControlHost.processOutput(stdout, { stderr: stderr ?? "" }),
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
        state: { category: "open", name: "open" },
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
});
