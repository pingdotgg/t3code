import * as GitHub from "@/GitHub";
import { GitHubCredentials } from "@/GitHub/Credentials.ts";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (owner !== "alchemy-run-test" && owner !== "alchemy-run-test-2") {
  throw new Error(
    `Refusing GitHub Ruleset tests for unauthorized owner: ${owner}`,
  );
}

const { test } = Test.make({
  providers: GitHub.providers({ baseUrl: "github.com" }),
});

const fixtureNames = [
  "alchemy-pr-1570-ruleset-lifecycle",
  "alchemy-pr-1570-ruleset-list",
  "alchemy-pr-1570-ruleset-replace-a",
  "alchemy-pr-1570-ruleset-replace-b",
];

// Retain public fixtures: the gh token lacks delete_repo, and private rulesets are plan-gated.
const repository = (name: string, id = "Repo") =>
  GitHub.Repository(id, {
    owner,
    name,
    visibility: "public",
    autoInit: true,
  });

const repoName = (repo: GitHub.Repository) =>
  Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!);

const getRuleset = (repo: string, rulesetId: number) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: () =>
        octokit.rest.repos.getRepoRuleset({
          owner,
          repo,
          ruleset_id: rulesetId,
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

const getRulesets = (repo: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: () =>
        octokit.paginate(octokit.rest.repos.getRepoRulesets, {
          owner,
          repo,
          includes_parents: false,
          per_page: 100,
        }),
      catch: (error) => error as Error,
    });
  });

test.provider("create, update, clear, and delete a ruleset", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const repo = fixtureNames[0]!;
    const deploy = (props: Omit<GitHub.RulesetProps, "owner" | "repository">) =>
      stack.deploy(
        Effect.gen(function* () {
          const fixture = yield* repository(repo);
          return yield* GitHub.Ruleset("MainProtection", {
            owner,
            repository: repoName(fixture),
            ...props,
          }).pipe(destroy());
        }),
      );

    const created = yield* deploy({
      name: "main protection",
      conditions: { include: ["refs/heads/main"] },
      bypassActors: [{ actorType: "RepositoryRole", actorId: 5 }],
      rules: {
        nonFastForward: true,
        deletion: true,
        update: true,
        pullRequest: {},
        requiredStatusChecks: { checks: [{ context: "ci/test" }] },
      },
    });
    expect(created.rulesetId).toBeGreaterThan(0);
    expect(created.name).toBe("main protection");
    const fetched = yield* getRuleset(repo, created.rulesetId);
    expect(fetched?.name).toBe("main protection");
    expect(fetched?.enforcement).toBe("active");
    expect(fetched?.rules?.map((rule) => rule.type).sort()).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
      "update",
    ]);
    expect(fetched?.bypass_actors).toEqual([
      { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
    ]);
    expect(created.createdAt).toBe(fetched?.created_at);

    const updated = yield* deploy({
      name: "updated main protection",
      enforcement: "disabled",
      conditions: { include: ["refs/heads/main", "refs/heads/release/*"] },
      rules: {
        nonFastForward: true,
        requiredLinearHistory: true,
        update: false,
      },
    });
    expect(updated.rulesetId).toBe(created.rulesetId);
    expect(updated.nodeId).toBe(created.nodeId);
    expect(updated.name).toBe("updated main protection");
    const afterUpdate = yield* getRuleset(repo, updated.rulesetId);
    expect(afterUpdate?.name).toBe("updated main protection");
    expect(afterUpdate?.enforcement).toBe("disabled");
    expect(afterUpdate?.conditions?.ref_name?.include).toEqual([
      "refs/heads/main",
      "refs/heads/release/*",
    ]);
    expect(afterUpdate?.rules?.map((rule) => rule.type).sort()).toEqual([
      "non_fast_forward",
      "required_linear_history",
    ]);
    expect(afterUpdate?.bypass_actors ?? []).toEqual([]);

    const cleared = yield* deploy({ name: "all branches" });
    expect(cleared.rulesetId).toBe(created.rulesetId);
    const afterClear = yield* getRuleset(repo, cleared.rulesetId);
    expect(afterClear?.conditions?.ref_name).toEqual({
      include: ["~ALL"],
      exclude: [],
    });
    expect(afterClear?.rules ?? []).toEqual([]);
    expect(afterClear?.enforcement).toBe("active");

    // Delete the ruleset while its repository is still managed, then release the fixture.
    yield* stack.deploy(repository(repo));
    expect(yield* getRuleset(repo, created.rulesetId)).toBeUndefined();
    expect(yield* getRulesets(repo)).toEqual([]);
    yield* stack.destroy();
  }),
);

test.provider("list rulesets across test repositories", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const repo = fixtureNames[1]!;
    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const fixture = yield* repository(repo);
        return yield* GitHub.Ruleset("ListedRuleset", {
          owner,
          repository: repoName(fixture),
          name: "listed tag protection",
          target: "tag",
          rules: { deletion: true },
        }).pipe(destroy());
      }),
    );
    const credentials = yield* yield* GitHubCredentials;
    const provider = yield* Provider.findProvider(GitHub.Ruleset);
    // list() enumerates /user/repos; confine it to this suite's fixture.
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
                  url.pathname !== `/repos/${owner}/${repo}/rulesets`)
              ) {
                throw new Error(`Unsafe Ruleset list request: ${url}`);
              }
            });
            octokit.hook.after("request", (response, options) => {
              const url = new URL(options.url, "https://api.github.com");
              if (url.pathname === `/orgs/${owner}/repos`) {
                response.data = (
                  response.data as Array<{ name: string }>
                ).filter((repository) => repository.name === repo);
              }
            });
            return octokit;
          },
        }),
      ),
    );
    const found = listed.find(
      (ruleset) => ruleset.rulesetId === created.rulesetId,
    );
    expect(found?.name).toBe("listed tag protection");
    expect(found?.nodeId).toBe(created.nodeId);
    expect((yield* getRuleset(repo, created.rulesetId))?.target).toBe("tag");

    yield* stack.deploy(repository(repo));
    expect(yield* getRuleset(repo, created.rulesetId)).toBeUndefined();
    expect(yield* getRulesets(repo)).toEqual([]);
    yield* stack.destroy();
  }),
);

test.provider("changing the repository replaces the ruleset", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const repoA = fixtureNames[2]!;
    const repoB = fixtureNames[3]!;
    const fixtures = Effect.gen(function* () {
      const a = yield* repository(repoA, "RepoA");
      const b = yield* repository(repoB, "RepoB");
      return { a, b };
    });
    const deploy = (destination: "a" | "b") =>
      stack.deploy(
        Effect.gen(function* () {
          const repos = yield* fixtures;
          return yield* GitHub.Ruleset("Protection", {
            owner,
            repository: repoName(repos[destination]),
            name: "replacement protection",
            rules: { nonFastForward: true },
          }).pipe(destroy());
        }),
      );
    const created = yield* deploy("a");
    expect((yield* getRuleset(repoA, created.rulesetId))?.name).toBe(
      "replacement protection",
    );
    const replaced = yield* deploy("b");
    expect(replaced.rulesetId).not.toBe(created.rulesetId);
    expect(yield* getRuleset(repoA, created.rulesetId)).toBeUndefined();
    expect((yield* getRuleset(repoB, replaced.rulesetId))?.name).toBe(
      "replacement protection",
    );

    yield* stack.deploy(fixtures);
    expect(yield* getRuleset(repoB, replaced.rulesetId)).toBeUndefined();
    expect(yield* getRulesets(repoA)).toEqual([]);
    expect(yield* getRulesets(repoB)).toEqual([]);
    yield* stack.destroy();
  }),
);
