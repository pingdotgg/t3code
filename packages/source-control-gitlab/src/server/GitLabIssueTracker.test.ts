import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabIssueTracker from "./GitLabIssueTracker.ts";

const encode = (value: unknown) => JSON.stringify(value);

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
  if (path === "projects/acme%2Fweb/issues/42") return encode(ISSUE);
  if (path.startsWith("projects/acme%2Fweb/issues/42/notes")) {
    return encode([
      {
        id: 7,
        body: "Repro attached.",
        author: { username: "julius" },
        created_at: "2026-07-02T00:00:00Z",
      },
      {
        id: 8,
        body: "closed",
        author: { username: "theo" },
        created_at: "2026-07-03T00:00:00Z",
        system: true,
      },
      {
        id: 9,
        body: "added ~7 label",
        author: { username: "theo" },
        created_at: "2026-07-03T00:00:00Z",
        system: true,
      },
    ]);
  }
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
  if (path.startsWith("projects/acme%2Fweb/issues/42/award_emoji")) {
    return encode([{ id: 11, name: "eyes", user: { username: "theo" } }]);
  }
  if (path === "graphql") {
    return encode({
      data: {
        currentUser: { username: "julius" },
        project: {
          mergeRequest: {
            notes: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: "gid://gitlab/Note/7",
                  awardEmoji: {
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
  }
  throw new Error(`unexpected path ${path}`);
}

function tracker(
  onExecute: (
    args: ReadonlyArray<string>,
    input: { readonly host?: string | undefined; readonly stdin?: string },
  ) => string,
) {
  return GitLabIssueTracker.make.pipe(
    Effect.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: (input) =>
          Effect.succeed(TestSourceControlHost.processOutput(onExecute(input.args, input))),
      }),
    ),
  );
}

describe("GitLabIssueTracker", () => {
  it.effect("joins the detail's endpoints into the neutral issue shape", () =>
    Effect.gen(function* () {
      const hosts = new Set<string | undefined>();
      const awardCursors: unknown[] = [];
      const api = yield* tracker((args, input) => {
        hosts.add(input.host);
        if (args[1] === "graphql") {
          const request = JSON.parse(input.stdin!);
          // gitlab.com's schema has no `Issue.awardEmoji`; glab exits 1 on such a query.
          const issueFields = /issue\(iid: \$iid\) \{([\s\S]*?)notes\(/.exec(request.query)?.[1];
          if (issueFields?.includes("awardEmoji")) {
            throw new Error("Field 'awardEmoji' doesn't exist on type 'Issue'");
          }
          awardCursors.push(request.variables.cursor);
        }
        return answer(args[1]!);
      });
      const target = { cwd: "/w", host: "gitlab.example.com", scope: "acme/web", key: "42" };
      const issue = yield* api.getIssue(target);
      // A later page of comments carries its own awards, found by the cursor's second half.
      const later = yield* api.getComments({ ...target, cursor: "2:after-100" });
      expect(later.comments.map((comment) => comment.reactions?.[0]?.count)).toEqual([2]);
      expect(awardCursors).toEqual([null, "after-100"]);
      // Every request names the tracker's own host rather than leaving glab to pick one.
      expect([...hosts]).toEqual(["gitlab.example.com"]);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        state: { category: "closed", name: "Closed" },
        states: [
          { category: "open", name: "Open" },
          { category: "closed", name: "Closed" },
        ],
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

  it.effect("keeps system events after the first hundred notes in the issue timeline", () =>
    Effect.gen(function* () {
      const firstPage = Array.from({ length: 100 }, (_, index) => ({
        id: index + 1000,
        body: "Discussion",
        author: { username: "julius" },
        created_at: "2026-07-02T00:00:00Z",
      }));
      const api = yield* tracker((args) => {
        const path = args[1]!;
        if (path.includes("/notes?")) {
          const page = new URLSearchParams(path.split("?")[1]).get("page");
          if (page === "1") return encode(firstPage);
          if (page === "2") {
            return encode([
              {
                id: 1100,
                body: "closed",
                system: true,
                author: { username: "theo" },
                created_at: "2026-07-03T00:00:00Z",
              },
            ]);
          }
          return encode([]);
        }
        return answer(path);
      });
      const target = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42" };
      const issue = yield* api.getIssue(target);
      let cursor = issue.commentsCursor;
      while (cursor !== null) {
        cursor = (yield* api.getComments({ ...target, cursor })).nextCursor;
      }
      expect(issue.events).toContainEqual(
        expect.objectContaining({ id: "note-1100", kind: "closed" }),
      );
    }),
  );

  it.effect("follows GitLab's next page past a short page of notes", () =>
    Effect.gen(function* () {
      const notes = (next: string, rows: ReadonlyArray<unknown>) =>
        `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nX-Next-Page: ${next}\r\nX-Page: 1\r\n\r\n${encode(rows)}`;
      const api = yield* tracker((args) => {
        const path = args[1]!;
        if (path.includes("/notes?")) {
          const params = new URLSearchParams(path.split("?")[1]);
          if (params.get("activity_filter") === "only_activity") {
            return params.get("page") === "1"
              ? notes("2", [])
              : notes("", [
                  {
                    id: 300,
                    body: "closed",
                    system: true,
                    author: { username: "theo" },
                    created_at: "2026-07-03T00:00:00Z",
                  },
                ]);
          }
          return notes("2", [
            {
              id: 1,
              body: "Hi",
              author: { username: "julius" },
              created_at: "2026-07-02T00:00:00Z",
            },
          ]);
        }
        return answer(path);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        key: "42",
      });
      expect(issue.commentsCursor).toBe("2");
      expect(issue.events.map((event) => event.id)).toEqual(["label-3", "note-300"]);
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
        sort: "updated",
        limit: 1,
        cursor: "3",
      });
      expect(paths[0]).toBe(
        "projects/acme%2Fweb/issues?state=opened&assignee_username=julius&order_by=updated_at&sort=desc&per_page=1&page=3",
      );
      // A named assignee takes the one parameter GitLab reads, so "assigned to me" drops rows here.
      const both = yield* api.listIssues({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        state: "open",
        involvement: "assigned",
        viewer: "julius",
        labels: ["bug", "needs triage"],
        assignee: "theo",
        sort: "created",
        limit: 1,
      });
      expect(paths[1]).toBe(
        "projects/acme%2Fweb/issues?state=opened&labels=bug%2Cneeds%20triage&assignee_username=theo&order_by=created_at&sort=desc&per_page=1&page=1",
      );
      expect(both.items).toEqual([]);
      expect(page.items[0]?.key).toBe("42");
      expect(page.nextCursor).toBe("4");
    }),
  );

  it.effect("lists each issue's labels with the colour GitLab gave them", () =>
    Effect.gen(function* () {
      // GitLab details labels only when asked; otherwise it answers bare names.
      const api = yield* tracker((args) =>
        encode([
          {
            ...ISSUE,
            labels: args[1]!.includes("with_labels_details=true")
              ? [{ id: 1, name: "bug", color: "#d9534f", text_color: "#FFFFFF" }]
              : ["bug"],
          },
        ]),
      );
      const page = yield* api.listIssues({
        cwd: "/w",
        host: "gitlab.com",
        scope: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "julius",
        sort: "updated",
        limit: 1,
      });
      expect(page.items[0]?.labels).toEqual([{ name: "bug", color: "#d9534f" }]);
    }),
  );

  it.effect("removes the viewer's own award by id, paging until it is found", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const api = yield* tracker((args) => {
        const path = args[1]!;
        calls.push(args.includes("DELETE") ? `DELETE ${path}` : path);
        if (path === "user") return encode({ username: "julius" });
        if (path.endsWith("page=1")) {
          return encode([{ id: 1, name: "thumbsup", user: { username: "theo" } }]);
        }
        if (path.endsWith("page=2") && path.includes("/notes/7/")) {
          return encode([{ id: 9, name: "thumbsup", user: { username: "julius" } }]);
        }
        return "[]";
      });
      const target = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42" };
      yield* api.setReaction!({ ...target, subjectId: "7", content: "thumbs-up", reacted: false });
      expect(calls.at(-1)).toBe("DELETE projects/acme%2Fweb/issues/42/notes/7/award_emoji/9");
      // Nothing to delete is success, with no DELETE sent.
      calls.length = 0;
      yield* api.setReaction!({ ...target, content: "thumbs-up", reacted: false });
      expect(calls).toEqual([
        "user",
        "projects/acme%2Fweb/issues/42/award_emoji?per_page=100&page=1",
        "projects/acme%2Fweb/issues/42/award_emoji?per_page=100&page=2",
      ]);
    }),
  );

  it.effect("writes a kept assignee by the id its username resolves to", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const bodies: string[] = [];
      const api = yield* tracker((args, input) => {
        const path = args[1]!;
        calls.push(path);
        if (input.stdin !== undefined) bodies.push(input.stdin);
        if (path === "users?username=theo") return encode([{ id: 2, username: "theo" }]);
        if (path.startsWith("users?username=")) return "[]";
        return "{}";
      });
      const target = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42" };
      // The issue's own assignee comes back by login; a newly picked one by id.
      yield* api.update!({ ...target, assignees: ["theo", "7"] });
      expect(calls).toEqual(["users?username=theo", "projects/acme%2Fweb/issues/42"]);
      expect(JSON.parse(bodies.at(-1)!)).toEqual({ assignee_ids: [2, 7] });
      const error = yield* Effect.flip(api.update!({ ...target, assignees: ["nobody"] }));
      expect(error.reason).toBe("failed");
    }),
  );

  it.effect("moves an issue to a state by its name and refuses any other name", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const api = yield* tracker((args, input) => {
        writes.push([args[1], JSON.parse(input.stdin ?? "null")]);
        return "{}";
      });
      const target = { cwd: "/w", host: "gitlab.com", scope: "acme/web", key: "42" };
      yield* api.setState!({ ...target, state: "Closed" });
      yield* api.setState!({ ...target, state: "Open" });
      // The category is not a state name: nothing is sent for it.
      const error = yield* Effect.flip(api.setState!({ ...target, state: "closed" }));
      expect(error).toMatchObject({ operation: "setState", reason: "failed" });
      expect(writes).toEqual([
        ["projects/acme%2Fweb/issues/42", { state_event: "close" }],
        ["projects/acme%2Fweb/issues/42", { state_event: "reopen" }],
      ]);
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
