import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Git from "@distilled.cloud/github/git";
import * as Issues from "@distilled.cloud/github/issues";
import * as Pulls from "@distilled.cloud/github/pulls";
import * as Repos from "@distilled.cloud/github/repos";
import * as Alchemy from "alchemy";
import { Action } from "alchemy/Action";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import GitHubBindingsWorker, {
  bindAll,
  callBinding,
  owner,
  Repo,
  repository,
} from "./fixtures/bindings-worker.ts";
import { gh } from "./scope.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), GitHub.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const stage = Test.defaultStage();
const scope = { owner, repo: repository };
const tags = [
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "provider:github",
  "provider:github:bindings",
  "live",
];

type Answer<A> = { data: A; error?: undefined } | { data?: undefined; error: { _tag: string } };
type Call = <A = any>(binding: string, request: unknown) => Effect.Effect<Answer<A>, any, any>;

// The `*Http` layers, driven over HTTP through a deployed Worker.
const WorkerStack = Alchemy.Stack(
  "GitHubBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* Repo;
    const worker = yield* GitHubBindingsWorker;
    return { url: worker.url.as<string>() };
  }),
);

const worker = beforeAll(deploy(WorkerStack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(WorkerStack), { timeout: 300_000 });

const callHttp: Call = <A>(binding: string, request: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* worker;
    const response = yield* Test.executeWhenReady(
      HttpClientRequest.post(`${url.replace(/\/+$/, "")}/${binding}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(request ?? {}),
      ),
    );
    expect(response.status).toBe(200);
    return (yield* response.json) as unknown as Answer<A>;
  });

// The `*Local` layers, driven through an Action: each call deploys the stack
// with a fresh input, so the Action body runs once per call.
const LocalBindings = Layer.mergeAll(
  GitHub.CreateIssueLocal,
  GitHub.GetIssueLocal,
  GitHub.UpdateIssueLocal,
  GitHub.ListIssuesLocal,
  GitHub.SearchIssuesLocal,
  GitHub.CreateIssueCommentLocal,
  GitHub.ListIssueCommentsLocal,
  GitHub.GetPullRequestLocal,
  GitHub.ListPullRequestsLocal,
  GitHub.CreatePullRequestLocal,
  GitHub.MergePullRequestLocal,
  GitHub.CreatePullRequestReviewLocal,
  GitHub.ListPullRequestReviewsLocal,
  GitHub.ListPullRequestReviewCommentsLocal,
  GitHub.ListPullRequestFilesLocal,
);

const localStack = (input: { binding: string; request: unknown; call: string }) =>
  Alchemy.Stack(
    "GitHubBindingsLocalStack",
    { providers, state: Alchemy.localState() },
    Effect.gen(function* () {
      const repo = yield* Repo;
      const Call = Action(
        "Call",
        Effect.gen(function* () {
          const bindings = yield* bindAll(repo);
          return Effect.fn(function* (input: { binding: string; request: unknown }) {
            return yield* callBinding(bindings, input.binding, input.request);
          });
        }).pipe(Effect.provide(LocalBindings)),
      );
      return yield* Call(input);
    }),
  );

// Suspended so every attempt (including retries) gets a fresh input.
const callLocal: Call = <A>(binding: string, request: unknown) =>
  Effect.suspend(() => deploy(localStack({ binding, request, call: crypto.randomUUID() }))).pipe(
    Effect.map((answer) => answer as unknown as Answer<A>),
  );

afterAll.skipIf(!!process.env.NO_DESTROY)(
  destroy(localStack({ binding: "", request: {}, call: "" })),
  { timeout: 120_000 },
);

class NotYet extends Data.TaggedError("NotYet")<{}> {}

// Issue lists and search lag writes; bounded so a real failure surfaces.
const indexed = { schedule: Schedule.spaced("5 seconds"), times: 18 };

const until = <A, E, R>(effect: Effect.Effect<A, E, R>, ready: (a: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(ready, () => new NotYet()),
    Effect.retry({ while: (error) => Predicate.isTagged(error, "NotYet"), ...indexed }),
  );

const deleteBranch = (branch: string) =>
  Effect.gen(function* () {
    yield* gh(Git.deleteRef({ ...scope, ref: `heads/${branch}` })).pipe(
      Effect.catchTag(["NotFound", "UnprocessableEntity"], () => Effect.void),
    );
  });

/**
 * Every binding, in dependency order, through one implementation. The pull
 * request merges into a throwaway base branch so `main` never changes.
 */
const scenario = (impl: "Http" | "Local", call: Call) => {
  const ok = <A = any>(binding: string, request?: unknown) =>
    call<A>(binding, request).pipe(
      Effect.map((answer) => {
        expect(answer.error).toBeUndefined();
        return answer.data as A;
      }),
    );

  const title = `alchemy bindings ${impl} ${stage} ${crypto.randomUUID()}`;
  const base = `alchemy-bindings-${impl.toLowerCase()}-${stage}-base`;
  const head = `alchemy-bindings-${impl.toLowerCase()}-${stage}-head`;
  const path = `alchemy-bindings/${impl.toLowerCase()}-${stage}.txt`;
  let issueNumber: number | undefined;
  let pullNumber: number | undefined;
  let reviewId: number | undefined;

  const resetBranches = Effect.gen(function* () {
    const repo = yield* gh(Repos.get(scope));
    const main = yield* gh(Git.getRef({ ...scope, ref: `heads/${repo.default_branch}` }));
    for (const branch of [base, head]) {
      yield* deleteBranch(branch);
      yield* gh(Git.createRef({ ...scope, ref: `refs/heads/${branch}`, sha: main.object.sha }));
    }
    yield* gh(
      Repos.createOrUpdateFileContents({
        ...scope,
        branch: head,
        path,
        message: `test: GitHub runtime bindings (${impl})`,
        content: Buffer.from(`line one\n${crypto.randomUUID()}\n`).toString("base64"),
      }),
    );
  });

  // Close the run's issue and drop its branches even when a test failed.
  afterAll(
    Effect.gen(function* () {
      if (issueNumber !== undefined) {
        yield* gh(Issues.update({ ...scope, issue_number: issueNumber!, state: "closed" }));
      }
      yield* deleteBranch(head);
      yield* deleteBranch(base);
    }),
  );

  describe.sequential(impl, () => {
    describe("CreateIssue", () => {
      test(
        "opens an issue in the bound repository",
        Effect.gen(function* () {
          const issue = yield* ok("CreateIssue", { title, body: "created by CreateIssue" });
          issueNumber = issue.number;
          expect(issue.title).toBe(title);
          const data = yield* gh(Issues.get({ ...scope, issue_number: issueNumber! }));
          expect(data.title).toBe(title);
          expect(data.body).toBe("created by CreateIssue");
        }),
        { tags, timeout: 180_000 },
      );
    });

    describe("GetIssue", () => {
      test(
        "gets an issue by number",
        Effect.gen(function* () {
          const issue = yield* ok("GetIssue", { issue_number: issueNumber });
          expect(issue.number).toBe(issueNumber);
          expect(issue.title).toBe(title);
        }),
        { tags },
      );

      test(
        "fails with IssueNotFound for a missing issue",
        Effect.gen(function* () {
          const answer = yield* call("GetIssue", { issue_number: 999_999_999 });
          expect(answer.error?._tag).toBe("IssueNotFound");
        }),
        { tags },
      );
    });

    describe("ListIssues", () => {
      test(
        "lists the repository's issues",
        Effect.gen(function* () {
          const issues = yield* until(
            ok<{ number: number }[]>("ListIssues", {
              state: "open",
              sort: "created",
              direction: "desc",
              per_page: 100,
            }),
            (issues) => issues.some((issue) => issue.number === issueNumber),
          );
          expect(issues.map((issue) => issue.number)).toContain(issueNumber);
        }),
        { tags, timeout: 150_000 },
      );
    });

    describe("SearchIssues", () => {
      test(
        "searches issues scoped to the bound repository",
        Effect.gen(function* () {
          const result = yield* until(
            ok<{ items: { number: number }[] }>("SearchIssues", { q: `"${title}" in:title` }),
            (result) => result.items.some((item) => item.number === issueNumber),
          );
          expect(result.items.map((item) => item.number)).toEqual([issueNumber]);
        }),
        { tags, timeout: 150_000 },
      );
    });

    describe("CreateIssueComment", () => {
      test(
        "comments on an issue",
        Effect.gen(function* () {
          const comment = yield* ok("CreateIssueComment", {
            issue_number: issueNumber,
            body: "comment from CreateIssueComment",
          });
          const data = yield* gh(Issues.getComment({ ...scope, comment_id: comment.id }));
          expect(data.body).toBe("comment from CreateIssueComment");
        }),
        { tags },
      );
    });

    describe("ListIssueComments", () => {
      test(
        "lists an issue's comments",
        Effect.gen(function* () {
          const comments = yield* ok<{ body: string }[]>("ListIssueComments", {
            issue_number: issueNumber,
          });
          expect(comments.map((comment) => comment.body)).toEqual([
            "comment from CreateIssueComment",
          ]);
        }),
        { tags },
      );
    });

    describe("UpdateIssue", () => {
      test(
        "closes an issue",
        Effect.gen(function* () {
          const issue = yield* ok("UpdateIssue", {
            issue_number: issueNumber,
            body: "updated by UpdateIssue",
            state: "closed",
            state_reason: "completed",
          });
          expect(issue.state).toBe("closed");
          const data = yield* gh(Issues.get({ ...scope, issue_number: issueNumber! }));
          expect(data.state).toBe("closed");
          expect(data.state_reason).toBe("completed");
          expect(data.body).toBe("updated by UpdateIssue");
        }),
        { tags },
      );

      test(
        "fails with IssueNotFound for a missing issue",
        Effect.gen(function* () {
          const answer = yield* call("UpdateIssue", { issue_number: 999_999_999, title: "x" });
          expect(answer.error?._tag).toBe("IssueNotFound");
        }),
        { tags },
      );
    });

    describe("CreatePullRequest", () => {
      test(
        "opens a pull request",
        Effect.gen(function* () {
          yield* resetBranches;
          const pull = yield* ok("CreatePullRequest", {
            title: `alchemy bindings ${impl} ${stage}`,
            head,
            base,
            body: "opened by CreatePullRequest",
          });
          pullNumber = pull.number;
          const data = yield* gh(Pulls.get({ ...scope, pull_number: pullNumber! }));
          expect(data.state).toBe("open");
          expect(data.head.ref).toBe(head);
          expect(data.base.ref).toBe(base);
        }),
        { tags, timeout: 120_000 },
      );
    });

    describe("GetPullRequest", () => {
      test(
        "gets a pull request as JSON",
        Effect.gen(function* () {
          const pull = yield* ok("GetPullRequest", { pull_number: pullNumber });
          expect(pull.number).toBe(pullNumber);
          expect(pull.head.ref).toBe(head);
        }),
        { tags },
      );

      test(
        "gets a pull request's diff as text",
        Effect.gen(function* () {
          const diff = yield* ok<string>("GetPullRequest", {
            pull_number: pullNumber,
            accept: "application/vnd.github.diff",
          });
          expect(diff).toContain(`diff --git a/${path} b/${path}`);
        }),
        { tags },
      );
    });

    describe("ListPullRequests", () => {
      test(
        "lists the repository's pull requests",
        Effect.gen(function* () {
          const pulls = yield* ok<{ number: number }[]>("ListPullRequests", {
            state: "open",
            base,
          });
          expect(pulls.map((pull) => pull.number)).toEqual([pullNumber]);
        }),
        { tags },
      );
    });

    describe("ListPullRequestFiles", () => {
      test(
        "lists the files a pull request changes",
        Effect.gen(function* () {
          const files = yield* ok<{ filename: string }[]>("ListPullRequestFiles", {
            pull_number: pullNumber,
          });
          expect(files.map((file) => file.filename)).toEqual([path]);
        }),
        { tags },
      );
    });

    describe("CreatePullRequestReview", () => {
      test(
        "submits a review with an inline comment",
        Effect.gen(function* () {
          const review = yield* ok("CreatePullRequestReview", {
            pull_number: pullNumber,
            event: "COMMENT",
            body: "review from CreatePullRequestReview",
            comments: [{ path, line: 1, body: "inline comment" }],
          });
          reviewId = review.id;
          const data = yield* gh(
            Pulls.getReview({
              ...scope,
              pull_number: pullNumber!,
              review_id: reviewId!,
            }),
          );
          expect(data.body).toBe("review from CreatePullRequestReview");
          expect(data.state).toBe("COMMENTED");
        }),
        { tags },
      );
    });

    describe("ListPullRequestReviews", () => {
      test(
        "lists a pull request's reviews",
        Effect.gen(function* () {
          const reviews = yield* ok<{ id: number }[]>("ListPullRequestReviews", {
            pull_number: pullNumber,
          });
          expect(reviews.map((review) => review.id)).toEqual([reviewId]);
        }),
        { tags },
      );
    });

    describe("ListPullRequestReviewComments", () => {
      test(
        "lists a pull request's inline review comments",
        Effect.gen(function* () {
          const comments = yield* ok<
            { body: string; path: string; pull_request_review_id: number }[]
          >("ListPullRequestReviewComments", { pull_number: pullNumber });
          expect(
            comments.map(({ body, path, pull_request_review_id }) => ({
              body,
              path,
              pull_request_review_id,
            })),
          ).toEqual([{ body: "inline comment", path, pull_request_review_id: reviewId }]);
        }),
        { tags },
      );
    });

    describe("MergePullRequest", () => {
      test(
        "merges a pull request",
        Effect.gen(function* () {
          const merged = yield* ok("MergePullRequest", {
            pull_number: pullNumber,
            merge_method: "squash",
          });
          expect(merged.merged).toBe(true);
          const data = yield* gh(Pulls.get({ ...scope, pull_number: pullNumber! }));
          expect(data.merged).toBe(true);
          expect(data.base.ref).toBe(base);
        }),
        { tags },
      );
    });
  });
};

scenario("Http", callHttp);
scenario("Local", callLocal);
