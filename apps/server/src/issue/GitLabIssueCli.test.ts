import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as GitLabIssueCli from "./GitLabIssueCli.ts";

const mockedExecute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();

const layer = it.layer(
  GitLabIssueCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: mockedExecute,
      }),
    ),
  ),
);

function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
  };
}

function awardPage(): string {
  return JSON.stringify({
    data: {
      currentUser: { username: "bilal" },
      project: { issue: { awardEmoji: { nodes: [] }, notes: { pageInfo: {}, nodes: [] } } },
    },
  });
}

function awards(count: number, firstId: number, viewer: string): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      name: "heart",
      user: { username: viewer },
    })),
  );
}

function issues(count: number, firstNumber: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      iid: firstNumber + index,
      title: `Issue ${firstNumber + index}`,
      web_url: `https://gitlab.com/acme/web/-/issues/${firstNumber + index}`,
      state: "opened",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    })),
  );
}

/** One issue as `/issues/:iid` answers with it. */
function issueJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    iid: 7,
    title: "The page never loads",
    web_url: "https://gitlab.com/acme/web/-/issues/7",
    state: "opened",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    author: { id: 1, username: "bilal" },
    ...overrides,
  });
}

/** A page of an issue's notes, which is what the conversation is read from. */
function notes(count: number, firstId: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      body: `note ${firstId + index}`,
      author: { username: "bilal" },
      created_at: "2026-07-01T00:00:00Z",
    })),
  );
}

/** A page of `resource_label_events`, which is where the labellings are read from. */
function labelEvents(count: number, firstId: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      id: firstId + index,
      action: "add",
      created_at: "2026-07-01T00:00:00Z",
      label: { name: "backend" },
    })),
  );
}

/** A page of either merge request link endpoint, which answer the same shape. */
function mergeRequests(count: number, firstIid: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      iid: firstIid + index,
      title: `Merge request ${firstIid + index}`,
      web_url: `https://gitlab.com/acme/web/-/merge_requests/${firstIid + index}`,
      state: "opened",
      references: { full: `acme/web!${firstIid + index}` },
    })),
  );
}

/** Which page a paged read asked for, which `per_page` must not be mistaken for. */
function pageOf(path: string): number {
  return Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
}

/** A row of `templates/issues`, which names a template but carries none of it. */
function templateEntries(
  entries: ReadonlyArray<{ readonly key: string; readonly name: string }>,
): string {
  return JSON.stringify(entries);
}

/** One template's own answer, which is the markdown its body starts out as. */
function templateContent(content: string): string {
  return JSON.stringify({ content });
}

/** The argv of the nth glab invocation. */
function argsOfCall(index: number): ReadonlyArray<string> {
  return callAt(index).args;
}

/** The whole nth invocation, so a request body can be asserted alongside its path. */
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

/** The path every read and write is addressed to, which is argv's second word. */
function pathOfCall(index: number): string {
  return argsOfCall(index)[1] ?? "";
}

/** Every path glab was asked for, in whatever order the concurrent reads issued them. */
function calledPaths(): ReadonlyArray<string> {
  return mockedExecute.mock.calls.map((call) => call[0].args[1] ?? "");
}

afterEach(() => {
  mockedExecute.mockReset();
});

layer("GitLabIssueCli.layer", (it) => {
  it.effect("asks GitLab for one row more than the page, to probe for a next page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issues(3, 1))));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const batch = yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2, 3]);
      assert.isFalse(batch.truncated);
      assert.strictEqual(batch.cursorAdvance, 3);
      assert.strictEqual(argsOfCall(0)[0], "api");
      const path = pathOfCall(0);
      expect(path).toContain("projects/acme%2Fweb/issues?");
      expect(path).toContain("state=opened");
      expect(path).toContain("order_by=updated_at");
      expect(path).toContain("sort=desc");
      expect(path).toContain("per_page=11");
      expect(path).toContain("page=1");
    }),
  );

  it.effect("asks GitLab for every state on the All tab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "all",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(pathOfCall(0)).toContain("state=all");
    }),
  );

  it.effect("filters by the assignee when the viewer is looking at their own work", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "assigned",
        viewer: "bilal",
        limit: 10,
      });

      // An array parameter even for one name, which is how GitLab declares it.
      expect(pathOfCall(0)).toContain("assignee_username[]=bilal");
    }),
  );

  it.effect("filters by the author when the viewer opened them", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "authored",
        viewer: "bilal",
        limit: 10,
      });

      expect(pathOfCall(0)).toContain("author_username=bilal");
    }),
  );

  it.effect("narrows nothing for a mention, which GitLab's project listing cannot express", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "mentioned",
        viewer: "bilal",
        limit: 10,
      });

      // `scope` would answer a different question, so the unnarrowed page is answered instead.
      const path = pathOfCall(0);
      expect(path).not.toContain("assignee_username");
      expect(path).not.toContain("author_username");
      expect(path).not.toContain("scope=");
    }),
  );

  it.effect("hands a search to GitLab's own search parameter, encoded", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: '-a&per_page=1 "b"',
      });

      const path = pathOfCall(0);
      expect(path).toContain("search=-a%26per_page%3D1%20%22b%22");
      // The page size the walk fixed is still the only one in the query.
      assert.strictEqual(path.match(/per_page=/g)?.length, 1);
    }),
  );

  it.effect("asks for no search at all when the reader typed only spaces", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        query: "   ",
      });

      expect(pathOfCall(0)).not.toContain("search=");
    }),
  );

  it.effect("carries on from the instant the last slice ended on", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issues(11, 151))));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const batch = yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
        cursor: { updatedBefore: "2026-07-02T00:00:00Z" },
      });

      // The boundary bounds the row set, so an issue touched between the two reads cannot shift
      // rows past the page. Inclusive, and the service drops what it has already sent at it.
      expect(pathOfCall(0)).toContain("updated_before=2026-07-02T00%3A00%3A00Z");
      // An offset into a list that moves under it would be the thing this replaces.
      expect(pathOfCall(0)).toContain("page=1");
      expect(batch.items.map((item) => item.number)).toEqual([
        151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
      ]);
      assert.isTrue(batch.truncated);
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );

  it.effect("asks for no boundary at all on a first page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(pathOfCall(0)).not.toContain("updated_before=");
    }),
  );

  it.effect("advances the cursor through malformed raw rows", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const rows = JSON.parse(issues(2, 1)) as ReadonlyArray<unknown>;
      mockedExecute.mockReturnValueOnce(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        Effect.succeed(output(JSON.stringify([{ iid: "malformed" }, ...rows]))),
      );
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const batch = yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 2,
      });

      expect(batch.items.map((item) => item.number)).toEqual([1, 2]);
      // The skipped row was still consumed, so the next slice starts past it.
      assert.strictEqual(batch.cursorAdvance, 3);
      assert.isTrue(batch.truncated);
    }),
  );

  it.effect("stops walking when every row on a page fails to decode", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const unusable = JSON.stringify(Array.from({ length: 100 }, () => ({ iid: "nope" })));
      mockedExecute.mockReturnValue(Effect.succeed(output(unusable)));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const batch = yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 150,
      });

      assert.strictEqual(batch.items.length, 0);
      // ceil((150 + 1) / 100) pages, not one request per page forever.
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
    }),
  );

  it.effect("addresses a nested group project by its encoded full path", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("[]")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.listIssues({
        cwd: "/w",
        repository: "acme/platform/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });

      expect(pathOfCall(0)).toContain("projects/acme%2Fplatform%2Fweb/issues");
    }),
  );

  it.effect("reads an issue with its description", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(issueJson({ description: "It 500s.", labels: ["backend"] }))),
      );
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const issue = yield* cli.getIssueDetail({ cwd: "/w", repository: "acme/web", number: 7 });

      assert.strictEqual(pathOfCall(0), "projects/acme%2Fweb/issues/7");
      expect(issue).toMatchObject({ number: 7, body: "It 500s.", state: "open" });
    }),
  );

  it.effect("fails the read when GitLab returns something unreadable", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output('{"message":"404 Not Found"}')));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const error = yield* Effect.flip(
        cli.getIssueDetail({ cwd: "/w", repository: "acme/web", number: 7 }),
      );

      assert.strictEqual(error._tag, "GitLabIssueReadError");
    }),
  );

  it.effect("fails when the authenticated account has no username", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ username: "" }))));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const error = yield* Effect.flip(cli.getViewerUsername({ cwd: "/w" }));

      assert.strictEqual(error._tag, "GitLabIssueViewerUnavailableError");
    }),
  );

  it.effect("reads the merge requests that close the issue and the ones that mention it", () =>
    Effect.gen(function* () {
      const mergeRequest = (iid: number, state: string) => ({
        iid,
        title: `Merge request ${iid}`,
        web_url: `https://gitlab.com/acme/web/-/merge_requests/${iid}`,
        state,
        references: { full: `acme/web!${iid}` },
      });
      mockedExecute
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify([mergeRequest(12, "merged")]))))
        .mockReturnValueOnce(
          Effect.succeed(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            output(JSON.stringify([mergeRequest(12, "merged"), mergeRequest(13, "opened")])),
          ),
        );
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const links = yield* cli.listLinkedMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(pathOfCall(0)).toContain("issues/7/closed_by?");
      expect(pathOfCall(1)).toContain("issues/7/related_merge_requests?");
      // The two endpoints overlap, and the stronger of the two relationships is the one kept.
      expect(links.map((link) => [link.number, link.closesIssue, link.state])).toEqual([
        [12, true, "merged"],
        [13, false, "open"],
      ]);
    }),
  );

  it.effect("reads the merge request links past the first hundred", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) => {
        const path = input.args[1] ?? "";
        if (!path.includes("closed_by")) return Effect.succeed(output("[]"));
        // A full page says nothing about being the last, so the short one after it ends the walk.
        return Effect.succeed(
          pageOf(path) === 1 ? output(mergeRequests(100, 1)) : output(mergeRequests(3, 101)),
        );
      });
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const links = yield* cli.listLinkedMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(links.length, 103);
      assert.strictEqual(mockedExecute.mock.calls.length, 3);
    }),
  );

  it.effect("stops the link walk at its bound, keeping one of a link answered twice", () =>
    Effect.gen(function* () {
      // A host that answers the same full page whatever page is asked for: the walk has to end
      // itself, and the repeats must not reach the panel as separate links.
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(
          (input.args[1] ?? "").includes("closed_by")
            ? output(mergeRequests(100, 1))
            : output("[]"),
        ),
      );
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const links = yield* cli.listLinkedMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      // Five pages of links and the one empty read beside them.
      assert.strictEqual(mockedExecute.mock.calls.length, 6);
      assert.strictEqual(links.length, 100);
    }),
  );

  it.effect("splits the conversation into remarks and a history, in order", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  id: 1,
                  body: "Reproduced.",
                  author: { username: "julius" },
                  created_at: "2026-07-02T00:00:00Z",
                },
                { id: 2, body: "closed", system: true, created_at: "2026-07-03T00:00:00Z" },
              ]),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  id: 4,
                  action: "add",
                  created_at: "2026-07-01T00:00:00Z",
                  label: { name: "backend" },
                },
              ]),
            ),
          ),
        );
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(awardPage())));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const activity = yield* cli.listActivity({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(pathOfCall(0)).toContain("issues/7/notes?");
      expect(pathOfCall(1)).toContain("issues/7/resource_label_events?");
      expect(activity.comments.map((comment) => comment.id)).toEqual(["1"]);
      // Two reads, one history: the labelling happened first whichever answered first.
      expect(activity.events.map((event) => event.id)).toEqual(["label-4", "note-2"]);
      assert.isFalse(activity.truncated);
    }),
  );

  it.effect("stops the conversation walk at its bound and says it was cut short", () =>
    Effect.gen(function* () {
      // GitLab that never answers short: the walk has to end itself.
      mockedExecute.mockImplementation((input) =>
        Effect.succeed(output(input.args[1] === "graphql" ? awardPage() : notes(100, 1))),
      );
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const activity = yield* cli.listActivity({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      // Ten pages of notes and ten of labellings, both bounded by the same limit.
      assert.strictEqual(mockedExecute.mock.calls.length, 21);
      assert.strictEqual(activity.comments.length, 1000);
      assert.isTrue(activity.truncated);
    }),
  );

  it.effect("says the history was cut short when only the labellings ran past the bound", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) => {
        const path = input.args[1] ?? "";
        // A quiet issue that has been relabelled all day: the conversation ends on its first page.
        return Effect.succeed(
          output(
            path === "graphql"
              ? awardPage()
              : path.includes("/notes?")
                ? notes(1, 1)
                : labelEvents(100, 1),
          ),
        );
      });
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const activity = yield* cli.listActivity({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(activity.comments.length, 1);
      assert.strictEqual(activity.events.length, 1000);
      // The labelling walk stopped at its bound, so the timeline is short whatever the notes did.
      assert.isTrue(activity.truncated);
    }),
  );

  it.effect("files a new issue with its body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issueJson({ iid: 9 }))));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const created = yield* cli.createIssue({
        cwd: "/w",
        repository: "acme/web",
        title: "true",
        body: "Steps to reproduce.",
        labels: ["backend"],
        assignees: ["5", "octocat"],
      });

      expect(argsOfCall(0)).toEqual([
        "api",
        "projects/acme%2Fweb/issues",
        "--method",
        "POST",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({
        title: "true",
        description: "Steps to reproduce.",
        labels: ["backend"],
        // A handle is not an id GitLab would take, so it names nobody and is left out.
        assignee_ids: [5],
      });
      expect(created).toEqual({ number: 9, url: "https://gitlab.com/acme/web/-/issues/7" });
    }),
  );

  it.effect("rewrites only the fields the edit carried", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.updateIssue({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        title: "A better title",
      });

      expect(argsOfCall(0)).toEqual([
        "api",
        "projects/acme%2Fweb/issues/7",
        "--method",
        "PUT",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      // The description is absent rather than empty, so a rename cannot blank a body.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ title: "A better title" });
    }),
  );

  it.effect("closes and reopens an issue through the same field of the issue", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      yield* cli.runIssueAction({ ...target, action: "close" });
      yield* cli.runIssueAction({ ...target, action: "reopen" });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ state_event: "close" });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ state_event: "reopen" });
      expect(argsOfCall(1)).toContain("PUT");
    }),
  );

  it.effect("sends a comment body over stdin, never in argv", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.commentOnIssue({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        body: "true",
      });

      expect(argsOfCall(0)).toEqual([
        "api",
        "projects/acme%2Fweb/issues/7/notes",
        "--method",
        "POST",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      // A JSON body, so a comment reading as a literal `true` stays text.
      expect(callAt(0).stdin).toBe('{"body":"true"}');
    }),
  );

  it.effect("rewrites an issue comment by its note id", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.updateComment({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        commentId: "42",
        body: "Second thoughts",
      });

      expect(argsOfCall(0)).toEqual([
        "api",
        "projects/acme%2Fweb/issues/7/notes/42",
        "--method",
        "PUT",
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
      ]);
      expect(callAt(0).stdin).toBe('{"body":"Second thoughts"}');
    }),
  );

  it.effect("adds and removes an issue reaction after paging its awards", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output("{}")))
        .mockReturnValueOnce(Effect.succeed(output('{"username":"bilal"}')))
        .mockReturnValueOnce(Effect.succeed(output(awards(100, 1, "theo"))))
        .mockReturnValueOnce(Effect.succeed(output(awards(1, 101, "bilal"))))
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      yield* cli.setReaction({ ...target, content: "heart", reacted: true });
      yield* cli.setReaction({ ...target, subjectId: "42", content: "heart", reacted: false });

      expect(pathOfCall(0)).toBe("projects/acme%2Fweb/issues/7/award_emoji?name=heart");
      expect(pathOfCall(2)).toBe(
        "projects/acme%2Fweb/issues/7/notes/42/award_emoji?per_page=100&page=1",
      );
      expect(pathOfCall(3)).toBe(
        "projects/acme%2Fweb/issues/7/notes/42/award_emoji?per_page=100&page=2",
      );
      expect(pathOfCall(4)).toBe("projects/acme%2Fweb/issues/7/notes/42/award_emoji/101");
    }),
  );

  it.effect("writes the whole label set, and the empty string to clear it", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      yield* cli.setLabels({ ...target, labels: ["backend", "needs, care"] });
      yield* cli.setLabels({ ...target, labels: [] });

      // An array, which no label name can break with a comma of its own.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ labels: ["backend", "needs, care"] });
      // GitLab documents the empty string, and only the empty string, as "take them all off".
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ labels: "" });
    }),
  );

  it.effect("assigns by the ids GitLab handed out, and ignores anything else", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      yield* cli.setAssignees({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        assignees: ["5", "octocat", "0", "-3"],
      });

      // Sending a handle as a number would write the assignee set around somebody nobody chose.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ assignee_ids: [5] });
    }),
  );

  it.effect("offers the project's labels and marks the ones the issue has", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(issueJson({ labels: ["backend"] }))))
        .mockReturnValueOnce(
          Effect.succeed(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            output(JSON.stringify([{ name: "backend" }, { name: "frontend", color: "#00ff00" }])),
          ),
        );
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const list = yield* cli.listLabelCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(pathOfCall(1), "projects/acme%2Fweb/labels?per_page=100");
      expect(list.candidates.map((candidate) => [candidate.name, candidate.isApplied])).toEqual([
        ["backend", true],
        ["frontend", false],
      ]);
      assert.isFalse(list.truncated);
    }),
  );

  it.effect("says the label list is not all of them when the host filled the page", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(issueJson({})))).mockReturnValueOnce(
        Effect.succeed(
          output(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ name: `l${index}` }))),
          ),
        ),
      );
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const list = yield* cli.listLabelCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      assert.isTrue(list.truncated);
    }),
  );

  it.effect("offers everyone the project lends it, and marks who is already assigned", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(issueJson({ assignees: [{ id: 5, username: "julius" }] }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                { id: 5, username: "julius" },
                { id: 9, username: "hubot" },
                // Nothing GitLab would take for this person, so they cannot be offered.
                { username: "ghost" },
              ]),
            ),
          ),
        );
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const list = yield* cli.listAssigneeCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      // `members/all`, so the people a parent group lends the project are offered too.
      assert.strictEqual(pathOfCall(1), "projects/acme%2Fweb/members/all?per_page=100");
      expect(list.candidates.map((candidate) => [candidate.id, candidate.isAssigned])).toEqual([
        ["5", true],
        ["9", false],
      ]);
      assert.isFalse(list.truncated);
    }),
  );

  it.effect("offers an assignee the member page never reached, by an id GitLab takes", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(issueJson({ assignees: [{ id: 42, username: "faraway" }] }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              // A full page of somebody else: GitLab caps it at a hundred, and this project has
              // more members than that, so the assignee is nowhere in what came back.
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify(
                Array.from({ length: 100 }, (_, index) => ({
                  id: index + 1,
                  username: `member${index}`,
                })),
              ),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;
      const target = { cwd: "/w", repository: "acme/web", number: 7 };

      const list = yield* cli.listAssigneeCandidates(target);

      const assignee = list.candidates.find((candidate) => candidate.login === "faraway");
      assert.isDefined(assignee);
      assert.isTrue(assignee.isAssigned);
      assert.isTrue(list.truncated);

      // The whole point of carrying them: the set is written from this list, so the id has to be
      // one the write keeps rather than one it drops on the floor.
      yield* cli.setAssignees({ ...target, assignees: [assignee.id] });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.parse(callAt(2).stdin ?? "")).toEqual({ assignee_ids: [42] });
    }),
  );

  it.effect("reads a project's templates in two steps, names then bodies", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) => {
        const path = input.args[1];
        if (path === "projects/acme%2Fweb/templates/issues") {
          return Effect.succeed(
            output(
              templateEntries([
                { key: "bug_report.md", name: "Bug report" },
                { key: "feature request.md", name: "Feature request" },
              ]),
            ),
          );
        }
        if (path === "projects/acme%2Fweb/templates/issues/bug_report.md") {
          return Effect.succeed(output(templateContent("## Steps to reproduce")));
        }
        if (path === "projects/acme%2Fweb/templates/issues/feature%20request.md") {
          return Effect.succeed(output(templateContent("## What problem")));
        }
        throw new Error(`unexpected path: ${path}`);
      });
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const list = yield* cli.listIssueTemplates({ cwd: "/w", repository: "acme/web" });

      // A space in the key still has to reach GitLab URL-encoded, like any other path segment.
      const paths = calledPaths();
      expect(paths).toContain("projects/acme%2Fweb/templates/issues");
      expect(paths).toContain("projects/acme%2Fweb/templates/issues/bug_report.md");
      expect(paths).toContain("projects/acme%2Fweb/templates/issues/feature%20request.md");
      assert.strictEqual(paths.length, 3);
      assert.deepStrictEqual(list, {
        templates: [
          {
            key: "bug_report.md",
            name: "Bug report",
            about: "",
            title: "",
            body: "## Steps to reproduce",
            labels: [],
            assignees: [],
          },
          {
            key: "feature request.md",
            name: "Feature request",
            about: "",
            title: "",
            body: "## What problem",
            labels: [],
            assignees: [],
          },
        ],
        contactLinks: [],
        blankIssuesEnabled: true,
      });
    }),
  );

  it.effect("drops a template whose body request fails, and keeps the rest", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) => {
        const path = input.args[1];
        if (path === "projects/acme%2Fweb/templates/issues") {
          return Effect.succeed(
            output(
              templateEntries([
                { key: "bug.md", name: "Bug" },
                { key: "broken.md", name: "Broken" },
              ]),
            ),
          );
        }
        if (path === "projects/acme%2Fweb/templates/issues/bug.md") {
          return Effect.succeed(output(templateContent("## Steps")));
        }
        if (path === "projects/acme%2Fweb/templates/issues/broken.md") {
          return Effect.fail(
            new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: new Error("boom"),
            }),
          );
        }
        throw new Error(`unexpected path: ${path}`);
      });
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const list = yield* cli.listIssueTemplates({ cwd: "/w", repository: "acme/web" });

      // A failed body read never fails the whole list: it just leaves that form out.
      expect(list.templates.map((template) => template.key)).toEqual(["bug.md"]);
      assert.strictEqual(list.blankIssuesEnabled, true);
    }),
  );

  it.effect("skips a listing row that cannot be decoded, and reads the rest", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) => {
        const path = input.args[1];
        if (path === "projects/acme%2Fweb/templates/issues") {
          return Effect.succeed(
            output(JSON.stringify([{ name: "No key" }, { key: "bug.md", name: "Bug" }])),
          );
        }
        if (path === "projects/acme%2Fweb/templates/issues/bug.md") {
          return Effect.succeed(output(templateContent("## Steps")));
        }
        throw new Error(`unexpected path: ${path}`);
      });
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const list = yield* cli.listIssueTemplates({ cwd: "/w", repository: "acme/web" });

      // The keyless row never reaches a body request: only the decodable one does.
      assert.strictEqual(mockedExecute.mock.calls.length, 2);
      expect(list.templates.map((template) => template.key)).toEqual(["bug.md"]);
    }),
  );

  it.effect("offers an empty template list, still open to filing blank", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(templateEntries([]))));
      const cli = yield* GitLabIssueCli.GitLabIssueCli;

      const list = yield* cli.listIssueTemplates({ cwd: "/w", repository: "acme/web" });

      assert.deepStrictEqual(list, { templates: [], contactLinks: [], blankIssuesEnabled: true });
      // No entries means no body request follows the listing.
      assert.strictEqual(mockedExecute.mock.calls.length, 1);
    }),
  );
});
