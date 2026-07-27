import * as GitHub from "@/GitHub";
import { Octokit } from "@/GitHub/Octokit.ts";
import * as Provider from "@/Provider";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GitHub.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deploying a secret needs an owner + repository the token can write to —
// the dedicated test org (never a real one). Set GITHUB_TEST_OWNER="" to
// skip.
const owner = process.env.GITHUB_TEST_OWNER ?? "alchemy-run-test";
const repository = process.env.GITHUB_TEST_REPOSITORY ?? "test-repo";

// GitHub never returns a secret's value, only its metadata — so `getRepoSecret`
// succeeding (vs. 404) is how we assert presence/absence out-of-band.
const secretExists = (name: string) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    return yield* Effect.tryPromise(async () => {
      try {
        await octokit.rest.actions.getRepoSecret({
          owner,
          repo: repository,
          secret_name: name,
        });
        return true;
      } catch (error: any) {
        if (error.status === 404) return false;
        throw error;
      }
    });
  });

test.provider.skipIf(!owner)(
  "Secrets resolves Config values before wrapping them as Redacted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const [secret] = yield* stack.deploy(
        Effect.gen(function* () {
          // `Repository` defaults to `retain`: ensure the host repo exists
          // (another suite may have deleted/recreated it mid-run) without
          // ever deleting it on destroy. Reconcile is idempotent.
          yield* GitHub.Repository("Repo", {
            owner,
            name: repository,
            description: "alchemy-effect secret test host",
            visibility: "private",
            autoInit: true,
          });

          return yield* GitHub.Secrets({
            owner,
            repository,
            secrets: {
              ALCHEMY_CONFIG_SECRET: Config.succeed("hunter2"),
            },
          });
        }),
      );

      // A Config value resolves to "hunter2", gets wrapped as Redacted, and is
      // encrypted + uploaded successfully — proven by a fresh `updatedAt`.
      expect(secret.updatedAt).toEqual(expect.any(String));

      // The secret really lives in GitHub now.
      expect(yield* secretExists("ALCHEMY_CONFIG_SECRET")).toBe(true);

      yield* stack.destroy();

      // ...and is gone after destroy.
      expect(yield* secretExists("ALCHEMY_CONFIG_SECRET")).toBe(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// `list()` for GitHub.Secret is non-listable (pattern (e) in
// processes/list-support.md): secrets are keyed by their parent
// (owner/repository[, environment]/name) which arrive as props, there is no
// ambient owner/repo scope, and GitHub exposes no account-wide enumeration —
// only list-secrets *within* a specific repo. So `list()` always returns `[]`,
// even when a secret exists in the cloud.
test.provider.skipIf(!owner)(
  "list returns an empty array for non-enumerable GitHub secrets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Prove `list()` still returns `[]` even with a real secret deployed
      // (it is not enumerable without scope).
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GitHub.Secret("ListSecret", {
            owner,
            repository,
            name: "ALCHEMY_LIST_TEST",
            value: Redacted.make("list-test-value"),
          }).pipe(destroy());
        }),
      );

      // The secret is really in GitHub even though `list()` can't see it.
      expect(yield* secretExists("ALCHEMY_LIST_TEST")).toBe(true);

      const provider = yield* Provider.findProvider(GitHub.Secret);
      const all = yield* provider.list();

      expect(all).toEqual([]);

      yield* stack.destroy();

      // ...and is gone after destroy.
      expect(yield* secretExists("ALCHEMY_LIST_TEST")).toBe(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
