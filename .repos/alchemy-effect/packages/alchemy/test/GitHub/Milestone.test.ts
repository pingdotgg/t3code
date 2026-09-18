import { GitHubCredentials } from "@/GitHub/Credentials.ts";
import * as GitHub from "@/GitHub/index.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output.ts";
import * as Provider from "@/Provider.ts";
import { destroy } from "@/RemovalPolicy.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (!["alchemy-run-test", "alchemy-run-test-2"].includes(owner)) {
  throw new Error(
    "GITHUB_TEST_OWNER must be alchemy-run-test or alchemy-run-test-2",
  );
}

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const repositoryName = (fixture: string) =>
  `alchemy-pr-1566-milestone-${fixture}`;

// Repositories are retained because the test token does not have delete_repo.
const repository = (name: string) =>
  GitHub.Repository("Repo", {
    owner,
    name: repositoryName(name),
    visibility: "public",
    autoInit: true,
  });

const fixture = (
  name: string,
  props: Omit<GitHub.MilestoneProps, "owner" | "repository">,
) =>
  Effect.gen(function* () {
    const repo = yield* repository(name);
    return yield* GitHub.Milestone("Milestone", {
      ...props,
      owner,
      repository: Output.map(
        repo.fullName,
        (fullName) => fullName.split("/")[1]!,
      ),
    }).pipe(destroy());
  });

const listMilestones = (fixture: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: () =>
        octokit.paginate(octokit.rest.issues.listMilestones, {
          owner,
          repo: repositoryName(fixture),
          state: "all",
          per_page: 100,
        }),
      catch: (error) => error as Error,
    });
  });

const verifyDeleted = (fixture: string) =>
  Effect.gen(function* () {
    expect(yield* listMilestones(fixture)).toEqual([]);
  });

test.provider(
  "create and update milestone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        fixture("update", {
          title: "v1.0.0",
          description: "First release",
        }),
      );
      expect(created.title).toBe("v1.0.0");
      expect(created.state).toBe("open");
      expect(created.description).toBe("First release");
      const updated = yield* stack.deploy(
        fixture("update", {
          title: "v1.0.0",
          description: "Updated: Bug fixes and improvements",
          dueOn: "2027-12-31",
        }),
      );
      expect(updated.milestoneNumber).toBe(created.milestoneNumber);
      expect(updated.description).toBe("Updated: Bug fixes and improvements");
      expect(updated.dueOn).toBe("2027-12-31T00:00:00Z");
      const observed = yield* listMilestones("update");
      expect(observed).toHaveLength(1);
      expect(observed[0]?.description).toBe(updated.description);
      expect(observed[0]?.due_on).toBe(updated.dueOn);
      yield* stack.deploy(repository("update"));
      yield* verifyDeleted("update");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "close and reopen milestone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        fixture("state", { title: "Release v2.0", state: "open" }),
      );
      expect(created.state).toBe("open");
      expect(created.closedAt).toBe(null);
      const closed = yield* stack.deploy(
        fixture("state", { title: "Release v2.0", state: "closed" }),
      );
      expect(closed.milestoneNumber).toBe(created.milestoneNumber);
      expect(closed.state).toBe("closed");
      expect(closed.closedAt).not.toBe(null);
      expect((yield* listMilestones("state"))[0]?.state).toBe("closed");
      const reopened = yield* stack.deploy(
        fixture("state", { title: "Release v2.0", state: "open" }),
      );
      expect(reopened.milestoneNumber).toBe(created.milestoneNumber);
      expect(reopened.state).toBe("open");
      expect(reopened.closedAt).toBe(null);
      expect((yield* listMilestones("state"))[0]?.state).toBe("open");
      yield* stack.deploy(repository("state"));
      yield* verifyDeleted("state");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "replace milestone when title changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        fixture("replace", {
          title: "Q1 2026",
          description: "First quarter goals",
        }),
      );
      expect(created.title).toBe("Q1 2026");
      const replaced = yield* stack.deploy(
        fixture("replace", {
          title: "Q1 2027",
          description: "Updated quarter goals",
        }),
      );
      expect(replaced.title).toBe("Q1 2027");
      expect(replaced.milestoneNumber).not.toBe(created.milestoneNumber);
      const observed = yield* listMilestones("replace");
      expect(observed.map((milestone) => milestone.number)).toEqual([
        replaced.milestoneNumber,
      ]);
      yield* stack.deploy(repository("replace"));
      yield* verifyDeleted("replace");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "list enumeration includes deployed milestone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        fixture("list", {
          title: "PR 1566 list milestone",
          description: "For list test",
        }),
      );
      const credentials = yield* yield* GitHubCredentials;
      const client = credentials.octokit({ baseUrl: undefined });
      client.hook.before("request", (options) => {
        if (options.url === "/user/repos") options.url = `/orgs/${owner}/repos`;
      });
      const provider = yield* Provider.findProvider(GitHub.Milestone);
      const allMilestones = yield* provider
        .list()
        .pipe(
          Effect.provideService(
            GitHubCredentials,
            Effect.succeed({ ...credentials, octokit: () => client }),
          ),
        );
      const found = allMilestones.find(
        (milestone) => milestone.nodeId === created.nodeId,
      );
      expect(found).toBeDefined();
      expect(found?.title).toBe(created.title);
      expect(found?.htmlUrl).toBe(created.htmlUrl);
      yield* stack.deploy(repository("list"));
      yield* verifyDeleted("list");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "milestone with due date",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        fixture("duedate", {
          title: "Sprint 1",
          description: "Complete authentication",
          dueOn: "2026-12-31",
        }),
      );
      expect(created.title).toBe("Sprint 1");
      expect(created.dueOn).toBe("2026-12-31T00:00:00Z");
      expect((yield* listMilestones("duedate"))[0]?.due_on).toBe(created.dueOn);
      yield* stack.deploy(repository("duedate"));
      yield* verifyDeleted("duedate");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "removing optional properties restores defaults",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        fixture("defaults", {
          title: "Defaults",
          state: "closed",
          description: "Remove me",
          dueOn: "2027-12-31",
        }),
      );
      const updated = yield* stack.deploy(
        fixture("defaults", { title: "Defaults" }),
      );
      expect(updated.milestoneNumber).toBe(created.milestoneNumber);
      expect(updated.state).toBe("open");
      expect(updated.description ?? "").toBe("");
      expect(updated.dueOn).toBe(null);
      const observed = (yield* listMilestones("defaults"))[0];
      expect(observed?.state).toBe("open");
      expect(observed?.description ?? "").toBe("");
      expect(observed?.due_on).toBe(null);
      yield* stack.deploy(repository("defaults"));
      yield* verifyDeleted("defaults");
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
