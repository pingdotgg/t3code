import * as GitHub from "@alchemy.run/github";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Repos from "@distilled.cloud/github/repos";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { destroy } from "alchemy/RemovalPolicy";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { gh, scopedToOwner } from "./scope.ts";

const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
if (owner !== "alchemy-run-test" && owner !== "alchemy-run-test-2") {
  throw new Error(`Refusing GitHub Ruleset tests for unauthorized owner: ${owner}`);
}

const { test } = Test.make({ providers: GitHub.providers({ baseUrl: "github.com" }) });

const fixtureNames = [
  "alchemy-pr-1570-ruleset-lifecycle",
  "alchemy-pr-1570-ruleset-list",
  "alchemy-pr-1570-ruleset-replace-a",
  "alchemy-pr-1570-ruleset-replace-b",
  "alchemy-pr-1570-ruleset-adopt",
  "alchemy-pr-1570-ruleset-legacy-rules",
];

// Retain public fixtures: the gh token lacks delete_repo, and private rulesets are plan-gated.
const repository = (name: string, id = "Repo") =>
  GitHub.Repository(id, { owner, name, visibility: "public", autoInit: true });

const repoName = (repo: GitHub.Repository) =>
  Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!);

const getRuleset = (repo: string, rulesetId: number) =>
  Effect.gen(function* () {
    return yield* gh(Repos.getRepoRuleset({ owner, repo, ruleset_id: rulesetId })).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

const getRulesets = (repo: string) =>
  Effect.gen(function* () {
    return yield* gh(
      Stream.runCollect(
        Repos.getRepoRulesets.items({
          owner,
          repo,
          includes_parents: false,
          per_page: 100,
        }),
      ),
    );
  });

test.provider(
  "create, update, clear, and delete a ruleset",
  (stack) =>
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
        nonFastForward: true,
        deletion: true,
        update: true,
        pullRequest: {
          allowedMergeMethods: ["squash"],
          requireExtraApprovalForUnattributedChanges: false,
        },
        requiredStatusChecks: { checks: [{ context: "ci/test" }] },
        mergeQueue: {
          mergeMethod: "SQUASH",
          groupingStrategy: "HEADGREEN",
          maxEntriesToBuild: 2,
          minEntriesToMerge: 1,
          maxEntriesToMerge: 1,
          minEntriesToMergeWaitMinutes: 1,
          checkResponseTimeoutMinutes: 30,
        },
      });
      expect(created.rulesetId).toBeGreaterThan(0);
      expect(created.name).toBe("main protection");
      const fetched = yield* getRuleset(repo, created.rulesetId);
      expect(fetched?.name).toBe("main protection");
      expect(fetched?.enforcement).toBe("active");
      expect(fetched?.rules?.map((rule) => rule.type).sort()).toEqual([
        "deletion",
        "merge_queue",
        "non_fast_forward",
        "pull_request",
        "required_status_checks",
        "update",
      ]);
      expect(
        fetched?.rules?.find((rule) => rule.type === "pull_request")?.parameters,
      ).toMatchObject({
        allowed_merge_methods: ["squash"],
        require_extra_approval_for_unattributed_changes: false,
      });
      expect(fetched?.rules?.find((rule) => rule.type === "merge_queue")?.parameters).toEqual({
        merge_method: "SQUASH",
        grouping_strategy: "HEADGREEN",
        max_entries_to_build: 2,
        min_entries_to_merge: 1,
        max_entries_to_merge: 1,
        min_entries_to_merge_wait_minutes: 1,
        check_response_timeout_minutes: 30,
      });
      expect(fetched?.bypass_actors).toEqual([
        { actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" },
      ]);
      expect(created.createdAt).toBe(fetched?.created_at);

      // Dropping both props resets them to GitHub's defaults: every merge
      // method is allowed again and the extra approval is required again.
      const relaxed = yield* deploy({
        name: "main protection",
        conditions: { include: ["refs/heads/main"] },
        bypassActors: [{ actorType: "RepositoryRole", actorId: 5 }],
        nonFastForward: true,
        deletion: true,
        update: true,
        pullRequest: {},
        requiredStatusChecks: { checks: [{ context: "ci/test" }] },
        mergeQueue: {},
      });
      expect(relaxed.rulesetId).toBe(created.rulesetId);
      const afterRelax = yield* getRuleset(repo, created.rulesetId);
      expect(
        afterRelax?.rules?.find((rule) => rule.type === "pull_request")?.parameters,
      ).toMatchObject({
        allowed_merge_methods: ["merge", "squash", "rebase"],
        require_extra_approval_for_unattributed_changes: true,
      });
      // An empty merge queue converges to GitHub's defaults.
      expect(afterRelax?.rules?.find((rule) => rule.type === "merge_queue")?.parameters).toEqual({
        merge_method: "MERGE",
        grouping_strategy: "ALLGREEN",
        max_entries_to_build: 5,
        min_entries_to_merge: 1,
        max_entries_to_merge: 5,
        min_entries_to_merge_wait_minutes: 5,
        check_response_timeout_minutes: 60,
      });

      const updated = yield* deploy({
        name: "updated main protection",
        enforcement: "disabled",
        conditions: { include: ["refs/heads/main", "refs/heads/release/*"] },
        nonFastForward: true,
        requiredLinearHistory: true,
        update: false,
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
      expect(afterClear?.conditions?.ref_name).toEqual({ include: ["~ALL"], exclude: [] });
      expect(afterClear?.rules ?? []).toEqual([]);
      expect(afterClear?.enforcement).toBe("active");

      // Delete the ruleset while its repository is still managed, then release the fixture.
      yield* stack.deploy(repository(repo));
      expect(yield* getRuleset(repo, created.rulesetId)).toBeUndefined();
      expect(yield* getRulesets(repo)).toEqual([]);
      yield* stack.destroy();
    }),
  { tags: ["provider:github", "provider:github:repository", "provider:github:ruleset", "live"] },
);

test.provider(
  "state persisted with nested rules diffs and reconciles against top-level rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const repo = fixtureNames[5]!;
      const ruleset = (props: Omit<GitHub.RulesetProps, "owner" | "repository" | "name">) =>
        Effect.gen(function* () {
          const fixture = yield* repository(repo);
          return yield* GitHub.Ruleset("LegacyRules", {
            owner,
            repository: repoName(fixture),
            name: "legacy rules",
            conditions: { include: ["refs/heads/main"] },
            ...props,
          }).pipe(destroy());
        });
      const ruleTypes = (rulesetId: number) =>
        Effect.map(getRuleset(repo, rulesetId), (ruleset) =>
          ruleset?.rules?.map((rule) => rule.type).sort(),
        );

      // Rewrites the persisted props into the shape written before the rules
      // moved to the top level: `rules: { nonFastForward, deletion, ... }`.
      const persistNestedRules = Effect.gen(function* () {
        const state = yield* yield* State;
        const scope = { stack: stack.name, stage: stack.stage, fqn: "LegacyRules" };
        const row = yield* state.get(scope);
        if (row === undefined || !("props" in row)) {
          return yield* Effect.die("LegacyRules has no persisted props");
        }
        const { nonFastForward, deletion, requiredLinearHistory, ...props } =
          row.props as GitHub.RulesetProps;
        yield* state.set({
          ...scope,
          value: {
            ...row,
            props: { ...props, rules: { nonFastForward, deletion, requiredLinearHistory } },
          },
        });
      });

      const created = yield* stack.deploy(ruleset({ nonFastForward: true, deletion: true }));
      expect(yield* ruleTypes(created.rulesetId)).toEqual(["deletion", "non_fast_forward"]);

      // The same rules plan a noop against the nested state and leave GitHub untouched.
      yield* persistNestedRules;
      const plan = yield* stack.plan(ruleset({ nonFastForward: true, deletion: true }));
      expect(plan.resources["LegacyRules"]).toMatchObject({ action: "noop" });
      const unchanged = yield* stack.deploy(ruleset({ nonFastForward: true, deletion: true }));
      expect(unchanged.rulesetId).toBe(created.rulesetId);
      expect((yield* getRuleset(repo, created.rulesetId))?.updated_at).toBe(created.updatedAt);

      // Changed rules update the ruleset in place from the nested state.
      yield* persistNestedRules;
      const changed = ruleset({ deletion: true, requiredLinearHistory: true });
      expect((yield* stack.plan(changed)).resources["LegacyRules"]).toMatchObject({
        action: "update",
      });
      const updated = yield* stack.deploy(changed);
      expect(updated.rulesetId).toBe(created.rulesetId);
      expect(yield* ruleTypes(created.rulesetId)).toEqual(["deletion", "required_linear_history"]);

      yield* stack.deploy(repository(repo));
      expect(yield* getRulesets(repo)).toEqual([]);
      yield* stack.destroy();
    }),
  { tags: ["provider:github", "provider:github:repository", "provider:github:ruleset", "live"] },
);

test.provider(
  "adopts an existing ruleset by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const repo = fixtureNames[4]!;
      yield* stack.deploy(repository(repo));
      const existing = yield* gh(
        Repos.createRepoRuleset({
          owner,
          repo,
          name: "adopted protection",
          target: "tag",
          enforcement: "active",
          rules: [{ type: "deletion" }],
        }),
      );
      yield* Effect.addFinalizer(() =>
        gh(Repos.deleteRepoRuleset({ owner, repo, ruleset_id: existing.id })).pipe(Effect.ignore),
      );

      const deploy = (enabled: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const fixture = yield* repository(repo);
            return yield* GitHub.Ruleset("AdoptedRuleset", {
              owner,
              repository: repoName(fixture),
              name: "adopted protection",
              conditions: { include: ["~DEFAULT_BRANCH"] },
              deletion: true,
              nonFastForward: true,
            }).pipe(adopt(enabled), destroy());
          }),
        );

      const refused = yield* deploy(false).pipe(Effect.flip);
      expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* deploy(true);
      expect(adopted.rulesetId).toBe(existing.id);
      const observed = yield* getRuleset(repo, existing.id);
      expect(observed?.target).toBe("branch");
      expect(observed?.conditions?.ref_name).toEqual({
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      });
      expect(observed?.rules?.map((rule) => rule.type).sort()).toEqual([
        "deletion",
        "non_fast_forward",
      ]);
      expect((yield* getRulesets(repo)).map((ruleset) => ruleset.id)).toEqual([existing.id]);

      yield* stack.deploy(repository(repo));
      expect(yield* getRulesets(repo)).toEqual([]);
      yield* stack.destroy();
    }),
  { tags: ["provider:github", "provider:github:repository", "provider:github:ruleset", "live"] },
);

test.provider(
  "list rulesets across test repositories",
  (stack) =>
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
            deletion: true,
          }).pipe(destroy());
        }),
      );
      const provider = yield* Provider.findProvider(GitHub.Ruleset);
      // list() enumerates /user/repos; confine it to this suite's fixture.
      const listed = yield* provider
        .list()
        .pipe(scopedToOwner(owner, { repository: repo, path: "rulesets" }));
      const found = listed.find((ruleset) => ruleset.rulesetId === created.rulesetId);
      expect(found?.name).toBe("listed tag protection");
      expect(found?.nodeId).toBe(created.nodeId);
      expect((yield* getRuleset(repo, created.rulesetId))?.target).toBe("tag");

      yield* stack.deploy(repository(repo));
      expect(yield* getRuleset(repo, created.rulesetId)).toBeUndefined();
      expect(yield* getRulesets(repo)).toEqual([]);
      yield* stack.destroy();
    }),
  { tags: ["provider:github", "provider:github:repository", "provider:github:ruleset", "live"] },
);

test.provider(
  "changing the repository replaces the ruleset",
  (stack) =>
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
              nonFastForward: true,
            }).pipe(destroy());
          }),
        );
      const created = yield* deploy("a");
      expect((yield* getRuleset(repoA, created.rulesetId))?.name).toBe("replacement protection");
      const replaced = yield* deploy("b");
      expect(replaced.rulesetId).not.toBe(created.rulesetId);
      expect(yield* getRuleset(repoA, created.rulesetId)).toBeUndefined();
      expect((yield* getRuleset(repoB, replaced.rulesetId))?.name).toBe("replacement protection");

      yield* stack.deploy(fixtures);
      expect(yield* getRuleset(repoB, replaced.rulesetId)).toBeUndefined();
      expect(yield* getRulesets(repoA)).toEqual([]);
      expect(yield* getRulesets(repoB)).toEqual([]);
      yield* stack.destroy();
    }),
  { tags: ["provider:github", "provider:github:repository", "provider:github:ruleset", "live"] },
);
