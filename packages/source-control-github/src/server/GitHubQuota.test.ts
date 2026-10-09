import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as GitHubQuota from "./GitHubQuota.ts";
import { CredentialScope } from "@t3tools/source-control-core/server/SourceControlRateLimit";

const RESET = Date.parse("2099-08-13T14:00:00Z");
const headers = (remaining: number, resource = "graphql", reset = RESET) => ({
  "x-ratelimit-resource": resource,
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(reset / 1000),
});

describe("GitHubQuota", () => {
  it.effect("refuses a background request below the reserve, per quota and account", () =>
    Effect.gen(function* () {
      const quota = yield* GitHubQuota.GitHubQuota;
      yield* quota.observe("github.com", headers(499));
      const refused = yield* Effect.flip(quota.admit("github.com", "graphql"));
      assert.strictEqual(refused.retryAt, RESET);
      // Another quota, another host and another account each have their own balance.
      yield* quota.admit("github.com", "core");
      yield* quota.admit("ghe.example", "graphql");
      yield* quota.admit("github.com", "graphql").pipe(Effect.provideService(CredentialScope, "b"));
      yield* quota.admit("github.com", "graphql", { allowReserve: true });
    }).pipe(Effect.provide(GitHubQuota.layer)),
  );

  it.effect("takes the latest balance in a window, and ignores an older window", () =>
    Effect.gen(function* () {
      const quota = yield* GitHubQuota.GitHubQuota;
      yield* quota.observe("github.com", headers(400));
      yield* Effect.flip(quota.admit("github.com", "graphql"));
      // GitHub can report more left later in the same window, from another region.
      yield* quota.observe("github.com", headers(900));
      yield* quota.admit("github.com", "graphql");
      yield* quota.observe("github.com", headers(400));
      yield* Effect.flip(quota.admit("github.com", "graphql"));
      // An answer from an older window says nothing about this one.
      yield* quota.observe("github.com", headers(4000, "graphql", RESET - 3_600_000));
      yield* Effect.flip(quota.admit("github.com", "graphql"));
      // A later window replaces it.
      yield* quota.observe("github.com", headers(4000, "graphql", RESET + 3_600_000));
      yield* quota.admit("github.com", "graphql");
    }).pipe(Effect.provide(GitHubQuota.layer)),
  );

  it.effect("lets interactive requests spend the reserve but not an empty quota", () =>
    Effect.gen(function* () {
      const quota = yield* GitHubQuota.GitHubQuota;
      yield* quota.observe("github.com", headers(1));
      yield* quota.admit("github.com", "graphql", { allowReserve: true });
      yield* quota.observe("github.com", headers(0));
      const refused = yield* Effect.flip(
        quota.admit("github.com", "graphql", { allowReserve: true }),
      );
      assert.strictEqual(refused.retryAt, RESET);
    }).pipe(Effect.provide(GitHubQuota.layer)),
  );

  it.effect("spends nothing locally, so a free 304 cannot run the balance down", () =>
    Effect.gen(function* () {
      const quota = yield* GitHubQuota.GitHubQuota;
      yield* quota.observe("github.com", headers(501, "core"));
      // Conditional reads answer 304 with the balance unchanged, however many are sent.
      for (let index = 0; index < 5; index++) {
        yield* quota.admit("github.com", "core");
        yield* quota.observe("github.com", headers(501, "core"));
      }
      yield* quota.admit("github.com", "core");
    }).pipe(Effect.provide(GitHubQuota.layer)),
  );

  it.effect("forgets a balance once its window resets, and ignores answers naming no quota", () =>
    Effect.gen(function* () {
      const quota = yield* GitHubQuota.GitHubQuota;
      yield* quota.observe("github.com", headers(0));
      yield* TestClock.setTime(RESET);
      yield* quota.admit("github.com", "graphql");
      yield* quota.observe("other.example", { "x-ratelimit-remaining": "0" });
      yield* quota.admit("other.example", "graphql");
    }).pipe(Effect.provide(GitHubQuota.layer)),
  );
});
