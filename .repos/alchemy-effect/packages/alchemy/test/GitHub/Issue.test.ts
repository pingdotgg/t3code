import * as GitHub from "@/GitHub";
import { GitHubCredentials } from "@/GitHub/Credentials.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (owner !== "alchemy-run-test" && owner !== "alchemy-run-test-2") {
  throw new Error(`Unsafe GITHUB_TEST_OWNER: ${owner}`);
}

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const repository = (id: string, name: string) =>
  GitHub.Repository(id, {
    owner,
    name,
    description: "Alchemy PR 1568 Issue integration fixture (retained)",
    visibility: "private",
    hasIssues: true,
    autoInit: true,
  });

const repoName = (repo: GitHub.Repository) =>
  Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!);

const getIssue = (repo: string, issueNumber: number) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    const { data } = yield* Effect.tryPromise(() =>
      octokit.rest.issues.get({ owner, repo, issue_number: issueNumber }),
    );
    return data;
  });

test.provider(
  "create closed, update, list, and close an issue on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = "alchemy-pr-1568-issue-lifecycle";
      const deployIssue = (
        props: Omit<GitHub.IssueProps, "owner" | "repository">,
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            // Repository deletion needs delete_repo; reuse this retained fixture.
            const repo = yield* repository("Repo", name);
            return yield* GitHub.Issue("Issue", {
              owner,
              repository: repoName(repo),
              ...props,
            }).pipe(destroy());
          }),
        );

      const created = yield* deployIssue({
        title: "PR 1568: initially closed",
        body: "\n    Initial body\n    Second line\n",
        labels: ["bug"],
        state: "closed",
      });
      expect(created.issueNumber).toBeGreaterThan(0);
      expect(created.nodeId).toBeTruthy();
      expect(created.htmlUrl).toBe(
        `https://github.com/${owner}/${name}/issues/${created.issueNumber}`,
      );
      expect(created.state).toBe("closed");
      const initial = yield* getIssue(name, created.issueNumber);
      expect(initial.state).toBe("closed");
      expect(initial.body).toBe("Initial body\nSecond line");
      expect(
        initial.labels.map((label) =>
          typeof label === "string" ? label : label.name,
        ),
      ).toEqual(["bug"]);

      const updated = yield* deployIssue({ title: "PR 1568: reopened" });
      expect(updated.issueNumber).toBe(created.issueNumber);
      expect(updated.nodeId).toBe(created.nodeId);
      expect(updated.state).toBe("open");
      const fetched = yield* getIssue(name, updated.issueNumber);
      expect(fetched.title).toBe("PR 1568: reopened");
      expect(fetched.body ?? "").toBe("");
      expect(fetched.labels).toEqual([]);
      expect(fetched.assignees).toEqual([]);
      expect(fetched.milestone).toBeNull();

      const credentials = yield* yield* GitHubCredentials;
      const provider = yield* Provider.findProvider(GitHub.Issue);
      const listed = yield* provider.list().pipe(
        Effect.provideService(
          GitHubCredentials,
          Effect.succeed({
            ...credentials,
            octokit: (override) => {
              const octokit = credentials.octokit(override);
              octokit.hook.before("request", (options) => {
                const url = new URL(options.url, "https://api.github.com");
                if (url.pathname === "/user/repos") {
                  url.pathname = `/orgs/${owner}/repos`;
                  options.url = url.toString();
                }
                if (
                  url.origin !== "https://api.github.com" ||
                  (url.pathname !== `/orgs/${owner}/repos` &&
                    url.pathname !== `/repos/${owner}/${name}/issues`)
                ) {
                  throw new Error(`Unsafe Issue list request: ${url}`);
                }
              });
              octokit.hook.after("request", (response, options) => {
                const url = new URL(options.url, "https://api.github.com");
                if (url.pathname === `/orgs/${owner}/repos`) {
                  response.data = (
                    response.data as Array<{ name: string }>
                  ).filter((repo) => repo.name === name);
                }
              });
              return octokit;
            },
          }),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
          until: (issues) =>
            issues.some((issue) => issue.nodeId === created.nodeId),
        }),
      );
      expect(listed.map((issue) => issue.nodeId)).toContain(created.nodeId);

      yield* stack.destroy();
      expect((yield* getIssue(name, created.issueNumber)).state).toBe("closed");
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:github",
      "provider:github:issue",
      "provider:github:repository",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "repository changes replace the issue and close the old generation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const firstName = "alchemy-pr-1568-issue-replace-a";
      const secondName = "alchemy-pr-1568-issue-replace-b";
      const deployIssue = (target: "first" | "second") =>
        stack.deploy(
          Effect.gen(function* () {
            // Keep both dependencies across replacement; retain the fixture repos.
            const first = yield* repository("FirstRepo", firstName);
            const second = yield* repository("SecondRepo", secondName);
            return yield* GitHub.Issue("Issue", {
              owner,
              repository: repoName(target === "first" ? first : second),
              title: "PR 1568: repository replacement",
            }).pipe(destroy());
          }),
        );

      const created = yield* deployIssue("first");
      expect((yield* getIssue(firstName, created.issueNumber)).state).toBe(
        "open",
      );
      const replaced = yield* deployIssue("second");
      expect(replaced.nodeId).not.toBe(created.nodeId);
      expect(replaced.htmlUrl).toContain(`/${secondName}/issues/`);
      expect((yield* getIssue(firstName, created.issueNumber)).state).toBe(
        "closed",
      );
      expect((yield* getIssue(secondName, replaced.issueNumber)).state).toBe(
        "open",
      );

      yield* stack.destroy();
      expect((yield* getIssue(secondName, replaced.issueNumber)).state).toBe(
        "closed",
      );
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:github",
      "provider:github:issue",
      "provider:github:repository",
      "live",
    ],
    timeout: 120_000,
  },
);
