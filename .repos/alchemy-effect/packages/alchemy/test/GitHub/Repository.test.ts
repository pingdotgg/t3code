import { adopt } from "@/AdoptPolicy";
import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GitHub.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// These tests create, mutate, and delete real repositories, so they run
// against the dedicated test orgs (never a real one). Set GITHUB_TEST_OWNER=""
// to skip the owner-scoped tests entirely. The second org hosts the target
// side of owner-change (replacement) tests.
const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
const owner2 = process.env.GITHUB_TEST_OWNER_2 ?? "alchemy-run-test-2";

const getRepo = (repo: string, repoOwner: string = owner) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const { data } = await octokit.rest.repos.get({
            owner: repoOwner,
            repo,
          });
          return data;
        } catch (error: any) {
          if (error.status === 404) return undefined;
          throw error;
        }
      },
      catch: (e) => e as Error,
    });
  });

test.provider.skipIf(!owner)(
  "create, update, rename, and delete a repository",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-effect-repo-test";
      const renamed = "alchemy-effect-repo-test-renamed";

      // Clean up any leftovers from a previous run before deploying.
      yield* stack.destroy();

      // Create
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner,
            name,
            description: "alchemy-effect integration test",
            visibility: "private",
            autoInit: true,
            // `hasIssues`, not `hasWiki`: wikis on PRIVATE repos are
            // plan-gated for orgs — GitHub accepts `has_wiki: true` on the
            // PATCH but silently keeps it false on a free-plan org, so a
            // wiki toggle can never be asserted here.
            hasIssues: false,
            topics: ["alchemy", "test"],
          }).pipe(destroy());
        }),
      );

      expect(created.repoId).toBeGreaterThan(0);
      expect(created.fullName).toEqual(`${owner}/${name}`);
      expect(created.defaultBranch).toBeDefined();

      const fetched = yield* getRepo(name);
      expect(fetched?.id).toEqual(created.repoId);
      expect(fetched?.description).toEqual("alchemy-effect integration test");
      expect(fetched?.private).toEqual(true);
      expect(fetched?.has_issues).toEqual(false);
      expect(fetched?.topics).toEqual(
        expect.arrayContaining(["alchemy", "test"]),
      );

      // Update — change settings and topics, same logical ID → same repoId.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner,
            name,
            description: "updated description",
            visibility: "private",
            hasIssues: true,
            topics: ["alchemy"],
          }).pipe(destroy());
        }),
      );

      expect(updated.repoId).toEqual(created.repoId);
      const afterUpdate = yield* getRepo(name);
      expect(afterUpdate?.description).toEqual("updated description");
      expect(afterUpdate?.has_issues).toEqual(true);
      expect(afterUpdate?.topics).toEqual(["alchemy"]);

      // Rename — new `name`, same logical ID → in-place rename, same repoId.
      const wasRenamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner,
            name: renamed,
            description: "updated description",
            visibility: "private",
          }).pipe(destroy());
        }),
      );

      expect(wasRenamed.repoId).toEqual(created.repoId);
      expect(wasRenamed.fullName).toEqual(`${owner}/${renamed}`);
      const afterRename = yield* getRepo(renamed);
      expect(afterRename?.id).toEqual(created.repoId);
      // GitHub keeps a permanent redirect from a renamed repository's old
      // name, and Octokit follows the 301 — so fetching the old name returns
      // the SAME repository under its new name rather than a 404.
      const oldName = yield* getRepo(name);
      expect(oldName?.id).toEqual(created.repoId);
      expect(oldName?.full_name).toEqual(`${owner}/${renamed}`);

      // Delete
      yield* stack.destroy();
      const afterDestroy = yield* getRepo(renamed);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!owner)(
  "list enumerates the deployed repository",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-effect-repo-list-test";

      // Clean up any leftovers from a previous run before deploying.
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("ListRepo", {
            owner,
            name,
            description: "alchemy-effect list integration test",
            visibility: "private",
            autoInit: true,
          }).pipe(destroy());
        }),
      );

      expect(deployed.repoId).toBeGreaterThan(0);

      const provider = yield* Provider.findProvider(GitHub.Repository);
      const all = yield* provider.list();

      // The deployed repository must appear in the exhaustively-paginated result.
      expect(all.some((r) => r.repoId === deployed.repoId)).toBe(true);
      const found = all.find((r) => r.repoId === deployed.repoId);
      expect(found?.fullName).toEqual(`${owner}/${name}`);

      yield* stack.destroy();
      const afterDestroy = yield* getRepo(name);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Owner changes are replacements, not moves (we never call GitHub's transfer
// API). With deletion opted in via `destroy()`, the replaced old-generation
// repo is deleted from the old org after the new one is created.
test.provider.skipIf(!owner || !owner2)(
  "changing the owner replaces the repository (destroy-opted)",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-effect-repo-owner-test";

      // Clean up any leftovers from a previous run. Repos a crashed run left
      // behind converge back under management when the deploy below re-takes
      // the same deterministic name (reconcile's create-race path).
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner,
            name,
            description: "alchemy-effect owner-change test",
            visibility: "private",
            autoInit: true,
          }).pipe(destroy());
        }),
      );
      expect(created.fullName).toEqual(`${owner}/${name}`);

      // Same logical ID, new owner → replacement: fresh repoId under the new
      // org, and (because deletion is opted in) the old repo is cleaned up.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner: owner2,
            name,
            description: "alchemy-effect owner-change test",
            visibility: "private",
            autoInit: true,
          }).pipe(destroy());
        }),
      );
      expect(replaced.fullName).toEqual(`${owner2}/${name}`);
      expect(replaced.repoId).not.toEqual(created.repoId);

      const oldRepo = yield* getRepo(name, owner);
      expect(oldRepo).toBeUndefined();
      const newRepo = yield* getRepo(name, owner2);
      expect(newRepo?.id).toEqual(replaced.repoId);

      yield* stack.destroy();
      const afterDestroy = yield* getRepo(name, owner2);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// The safety property: under the DEFAULT `retain` removal policy, an owner
// change creates the new repo but RETAINS the old one on GitHub — history is
// never destroyed by a replacement unless deletion was explicitly opted in.
test.provider.skipIf(!owner || !owner2)(
  "changing the owner retains the old repository by default",
  (stack) =>
    Effect.gen(function* () {
      const name = "alchemy-effect-repo-retain-test";

      // Clean up any leftovers from a previous run. Retained repos a prior
      // run left behind converge back under management when the deploys
      // below re-take the same deterministic names.
      yield* stack.destroy();

      // No `destroy()` pipe — the default `retain` policy applies.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner,
            name,
            description: "alchemy-effect retain-on-replace test",
            visibility: "private",
            autoInit: true,
          });
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Repository("Repo", {
            owner: owner2,
            name,
            description: "alchemy-effect retain-on-replace test",
            visibility: "private",
            autoInit: true,
          });
        }),
      );
      expect(replaced.repoId).not.toEqual(created.repoId);
      expect(replaced.fullName).toEqual(`${owner2}/${name}`);

      // The replaced old generation must still exist in the old org.
      const oldRepo = yield* getRepo(name, owner);
      expect(oldRepo?.id).toEqual(created.repoId);

      // Cleanup — all through the engine: adopt the retained repo back into
      // state under a second logical ID and flip both resources to the
      // `destroy` removal policy, so the final stack.destroy() deletes both.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          const current = yield* GitHub.Repository("Repo", {
            owner: owner2,
            name,
            description: "alchemy-effect retain-on-replace test",
            visibility: "private",
          }).pipe(destroy());

          const old = yield* GitHub.Repository("OldRepo", {
            owner,
            name,
            description: "alchemy-effect retain-on-replace test",
            visibility: "private",
          }).pipe(adopt(), destroy());

          return { current, old };
        }),
      );

      // The adopted resource converged onto the retained repo, not a new one.
      expect(adopted.old.repoId).toEqual(created.repoId);
      expect(adopted.current.repoId).toEqual(replaced.repoId);

      yield* stack.destroy();
      expect(yield* getRepo(name, owner)).toBeUndefined();
      expect(yield* getRepo(name, owner2)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Read-only enumeration: `list()` needs no owner — it walks every repository the
// authenticated token can see. Gated on a non-interactive token so CI never
// stalls on the auth-method prompt; exercises the live, exhaustively-paginated
// list path without creating a repo.
const hasToken = !!(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN);
test.provider.skipIf(!hasToken)(
  "list returns the authenticated user's repositories",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(GitHub.Repository);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const repo of all) {
        expect(typeof repo.repoId).toBe("number");
        expect(typeof repo.fullName).toBe("string");
        expect(repo.fullName).toContain("/");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
