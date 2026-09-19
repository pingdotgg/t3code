import * as Output from "@/Output.ts";
import * as Provider from "@/Provider.ts";
import { GitHubCredentials } from "@/GitHub/Credentials.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as GitHub from "@/GitHub/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (!["alchemy-run-test", "alchemy-run-test-2"].includes(owner)) {
  throw new Error(
    "GITHUB_TEST_OWNER must be alchemy-run-test or alchemy-run-test-2",
  );
}

const repoNameOf = (repo: GitHub.Repository) =>
  Output.map(repo.fullName, (name) => name.split("/")[1]!);

test.provider(
  "create and update label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const testId = "label-test";
      const repoName = `test-label-${testId}`;

      // Create a test repository with label
      const deploy1 = () =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* GitHub.Repository(testId, {
              owner,
              name: repoName,
              autoInit: true,
              visibility: "public",
            });

            const label = yield* GitHub.Label("bug", {
              owner,
              repository: repoNameOf(repo),
              name: "bug",
              color: "d73a4a",
              description: "Something isn't working",
            });

            return { repo, label };
          }),
        );

      const result1 = yield* deploy1();
      expect(result1.label.name).toBe("bug");
      expect(result1.label.color).toBe("d73a4a");
      expect(result1.label.description).toBe("Something isn't working");

      // Update the label
      const deploy2 = () =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* GitHub.Repository(testId, {
              owner,
              name: repoName,
              autoInit: true,
              visibility: "public",
            });

            const label = yield* GitHub.Label("bug", {
              owner,
              repository: repoNameOf(repo),
              name: "bug",
              color: "ff0000",
              description: "Updated: Critical bug",
            });

            return { repo, label };
          }),
        );

      const result2 = yield* deploy2();
      expect(result2.label.name).toBe("bug");
      expect(result2.label.color).toBe("ff0000");
      expect(result2.label.description).toBe("Updated: Critical bug");
      expect(result2.label.labelId).toBe(result1.label.labelId);

      const client = yield* Octokit;
      const observed = yield* Effect.tryPromise(() =>
        client.rest.issues.getLabel({ owner, repo: repoName, name: "bug" }),
      );
      expect(observed.data.id).toBe(result1.label.labelId);
      expect(observed.data.color).toBe("ff0000");
      expect(observed.data.description).toBe("Updated: Critical bug");

      yield* stack.destroy();
      const remaining = yield* Effect.tryPromise(() =>
        client.paginate(client.rest.issues.listLabelsForRepo, {
          owner,
          repo: repoName,
        }),
      );
      expect(remaining.some((label) => label.name === "bug")).toBe(false);
    }),
  { timeout: 120_000 },
);

test.provider(
  "create multiple labels",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const testId = "label-multi";
      const repoName = `test-label-${testId}`;

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* GitHub.Repository(testId, {
              owner,
              name: repoName,
              autoInit: true,
              visibility: "public",
            });

            const labels = {
              bug: yield* GitHub.Label("bug", {
                owner,
                repository: repoNameOf(repo),
                name: "bug",
                color: "d73a4a",
                description: "Something isn't working",
              }),
              feature: yield* GitHub.Label("feature", {
                owner,
                repository: repoNameOf(repo),
                name: "feature",
                color: "a2eeef",
                description: "New feature or request",
              }),
              documentation: yield* GitHub.Label("docs", {
                owner,
                repository: repoNameOf(repo),
                name: "documentation",
                color: "0075ca",
                description: "Improvements to documentation",
              }),
            };

            return { repo, labels };
          }),
        );

      const result = yield* deploy();
      expect(result.labels.bug.name).toBe("bug");
      expect(result.labels.feature.name).toBe("feature");
      expect(result.labels.documentation.name).toBe("documentation");

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "replace label when name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const testId = "label-replace";
      const repoName = `test-label-${testId}`;

      // Create label with original name
      const deploy1 = () =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* GitHub.Repository(testId, {
              owner,
              name: repoName,
              autoInit: true,
              visibility: "public",
            });

            const label = yield* GitHub.Label("work", {
              owner,
              repository: repoNameOf(repo),
              name: "wip",
              color: "fbca04",
            });

            return { repo, label };
          }),
        );

      const result1 = yield* deploy1();
      expect(result1.label.name).toBe("wip");
      const originalId = result1.label.labelId;

      // Change name (should replace)
      const deploy2 = () =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* GitHub.Repository(testId, {
              owner,
              name: repoName,
              autoInit: true,
              visibility: "public",
            });

            const label = yield* GitHub.Label("work", {
              owner,
              repository: repoNameOf(repo),
              name: "in-progress",
              color: "fbca04",
            });

            return { repo, label };
          }),
        );

      const result2 = yield* deploy2();
      expect(result2.label.name).toBe("in-progress");
      expect(result2.label.labelId).not.toBe(originalId);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "list enumeration includes deployed label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const testId = "label-list";
      const repoName = `test-label-${testId}`;

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* GitHub.Repository(testId, {
              owner,
              name: repoName,
              autoInit: true,
              visibility: "public",
            });

            const label = yield* GitHub.Label("test", {
              owner,
              repository: repoNameOf(repo),
              name: `test-${testId}`,
              color: "ededed",
              description: "For list test",
            });

            return { repo, label };
          }),
        );

      const result = yield* deploy();

      // List all labels and verify ours is included
      const credentials = yield* yield* GitHubCredentials;
      const client = credentials.octokit();
      client.hook.before("request", (options) => {
        if (options.url === "/user/repos") options.url = `/orgs/${owner}/repos`;
      });
      const provider = yield* Provider.findProvider(GitHub.Label);
      const allLabels = yield* provider
        .list()
        .pipe(
          Effect.provideService(
            GitHubCredentials,
            Effect.succeed({ ...credentials, octokit: () => client }),
          ),
        );
      const found = allLabels.find((l) => l.labelId === result.label.labelId);

      expect(found).toBeDefined();
      expect(found?.name).toBe(result.label.name);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "label with default color",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const testId = "label-default";
      const repoName = `test-label-${testId}`;

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const repo = yield* GitHub.Repository(testId, {
              owner,
              name: repoName,
              autoInit: true,
              visibility: "public",
            });

            const label = yield* GitHub.Label("custom", {
              owner,
              repository: repoNameOf(repo),
              name: "custom-label",
              // color omitted, should use default
              description: "Uses default color",
            });

            return { repo, label };
          }),
        );

      const result = yield* deploy();
      expect(result.label.name).toBe("custom-label");
      expect(result.label.color).toBeDefined();

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
