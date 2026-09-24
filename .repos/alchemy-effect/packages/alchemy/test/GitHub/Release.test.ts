import * as GitHub from "@/GitHub/index.ts";
import { GitHubCredentials } from "@/GitHub/Credentials.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output.ts";
import * as Provider from "@/Provider.ts";
import { destroy } from "@/RemovalPolicy.ts";
import * as Test from "@/Test/Alchemy.ts";
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

// Repositories are retained because the test token lacks delete_repo scope.
const repository = (name: string) =>
  GitHub.Repository("Repo", {
    owner,
    name: `alchemy-effect-pr-1577-release-${name}`,
    autoInit: true,
    visibility: "public",
    description: "Retained fixture for Alchemy PR #1577 release tests",
  });

const release = (
  fixture: string,
  props: Omit<GitHub.ReleaseProps, "owner" | "repository">,
) =>
  Effect.gen(function* () {
    const repo = yield* repository(fixture);
    return yield* GitHub.Release("Release", {
      ...props,
      owner,
      repository: Output.map(
        repo.fullName,
        (fullName) => fullName.split("/")[1]!,
      ),
    }).pipe(destroy());
  });

const getRelease = (fixture: string, releaseId: number) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: () =>
        octokit.rest.repos.getRelease({
          owner,
          repo: `alchemy-effect-pr-1577-release-${fixture}`,
          release_id: releaseId,
        }),
      catch: (error) => error as Error & { status?: number },
    }).pipe(
      Effect.map(({ data }) => data),
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(undefined),
      ),
    );
  });

const assertDeleted = (fixture: string, releaseId: number) =>
  Effect.gen(function* () {
    expect(yield* getRelease(fixture, releaseId)).toBeUndefined();
    const octokit = yield* Octokit;
    const { data } = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.repos.listReleases({
          owner,
          repo: `alchemy-effect-pr-1577-release-${fixture}`,
        }),
      catch: (error) => error as Error,
    });
    expect(data).toEqual([]);
  });

test.provider(
  "create and update release",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        release("update", {
          tagName: "v1.0.0",
          name: "Version 1.0.0",
          body: "First release",
        }),
      );
      expect(created.tagName).toBe("v1.0.0");
      expect(created.name).toBe("Version 1.0.0");
      expect(created.body).toBe("First release");
      expect(created.draft).toBe(false);
      expect(created.prerelease).toBe(false);
      expect((yield* getRelease("update", created.releaseId))?.body).toBe(
        "First release",
      );

      const updated = yield* stack.deploy(
        release("update", {
          tagName: "v1.0.0",
          name: "Version 1.0.0",
          body: "Updated: Bug fixes and improvements",
          prerelease: true,
        }),
      );
      expect(updated.releaseId).toBe(created.releaseId);
      expect(updated.body).toBe("Updated: Bug fixes and improvements");
      const observed = yield* getRelease("update", updated.releaseId);
      expect(observed?.body).toBe(updated.body);
      expect(observed?.prerelease).toBe(true);

      const reset = yield* stack.deploy(
        release("update", { tagName: "v1.0.0" }),
      );
      expect(reset.releaseId).toBe(created.releaseId);
      expect(reset.name).toBe("v1.0.0");
      expect(reset.body).toBe("");
      expect(reset.prerelease).toBe(false);
      const observedReset = yield* getRelease("update", reset.releaseId);
      expect(observedReset?.body).toBe("");
      expect(observedReset?.prerelease).toBe(false);
      yield* stack.deploy(repository("update"));
      yield* assertDeleted("update", reset.releaseId);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "create draft and publish",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        release("draft", {
          tagName: "v2.0.0",
          name: "Version 2.0.0",
          body: "Draft release notes",
          draft: true,
        }),
      );
      expect(created.draft).toBe(true);
      expect(created.publishedAt).toBe(null);
      expect((yield* getRelease("draft", created.releaseId))?.draft).toBe(true);

      const updated = yield* stack.deploy(
        release("draft", {
          tagName: "v2.0.0",
          name: "Version 2.0.0",
          body: "Published release notes",
          draft: false,
        }),
      );
      expect(updated.releaseId).toBe(created.releaseId);
      expect(updated.draft).toBe(false);
      expect(updated.publishedAt).not.toBe(null);
      const observed = yield* getRelease("draft", updated.releaseId);
      expect(observed?.draft).toBe(false);
      expect(observed?.body).toBe("Published release notes");
      yield* stack.deploy(repository("draft"));
      yield* assertDeleted("draft", updated.releaseId);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "create prerelease",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        release("prerelease", {
          tagName: "v3.0.0-beta.1",
          name: "v3.0.0 Beta 1",
          body: "Beta release for testing",
          prerelease: true,
        }),
      );
      expect(created.tagName).toBe("v3.0.0-beta.1");
      expect(created.prerelease).toBe(true);
      expect(created.draft).toBe(false);
      expect(
        (yield* getRelease("prerelease", created.releaseId))?.prerelease,
      ).toBe(true);
      yield* stack.deploy(repository("prerelease"));
      yield* assertDeleted("prerelease", created.releaseId);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "list enumeration includes deployed release",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        release("list", {
          tagName: "v1.0.0",
          name: "Test Release",
          body: "For list test",
        }),
      );
      const name = "alchemy-effect-pr-1577-release-list";
      const credentials = yield* yield* GitHubCredentials;
      const provider = yield* Provider.findProvider(GitHub.Release);
      // list() enumerates /user/repos; confine it to this suite's fixture.
      const all = yield* provider.list().pipe(
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
                    url.pathname !== `/repos/${owner}/${name}/releases`)
                ) {
                  throw new Error(`Unsafe Release list request: ${url}`);
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
        // Repository listings are eventually consistent for fresh fixtures.
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
          until: (releases) =>
            releases.some((item) => item.releaseId === created.releaseId),
        }),
      );
      expect(
        all.every((item) =>
          item.htmlUrl.startsWith(`https://github.com/${owner}/`),
        ),
      ).toBe(true);
      const found = all.find((item) => item.releaseId === created.releaseId);
      expect(found).toBeDefined();
      expect(found?.tagName).toBe(created.tagName);
      yield* stack.deploy(repository("list"));
      yield* assertDeleted("list", created.releaseId);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "tag change replaces release and deletes the old release",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(
        release("replace", { tagName: "v1.0.0" }),
      );
      const replaced = yield* stack.deploy(
        release("replace", { tagName: "v2.0.0" }),
      );
      expect(replaced.releaseId).not.toBe(created.releaseId);
      expect(replaced.tagName).toBe("v2.0.0");
      expect(yield* getRelease("replace", created.releaseId)).toBeUndefined();
      expect((yield* getRelease("replace", replaced.releaseId))?.tag_name).toBe(
        "v2.0.0",
      );
      yield* stack.deploy(repository("replace"));
      yield* assertDeleted("replace", replaced.releaseId);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
