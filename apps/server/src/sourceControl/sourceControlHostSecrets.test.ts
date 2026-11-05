import { assert, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";

import {
  collectSourceControlHostSecretReferences,
  invalidateSettingsSecrets,
  resolveSourceControlHostSecrets,
} from "./sourceControlHostSecrets.ts";

const source = (reference: string) => ({
  provider: SecretProviderId.make("homelab"),
  reference,
});

const secretsByReference = new Map([["bitbucket#token", "bb_from_provider"]]);

const hosts = {
  bitbucket: { email: "me@example.test", accessToken: source("bitbucket#token") },
  gitcafe: { token: source("missing#token") },
  github: { tokens: { "github.com": "ghp_literal" } },
};

function countingResolver() {
  const reads: Array<string> = [];
  const resolver = SecretResolver.SecretResolver.of({
    read: (references) =>
      Effect.sync(() =>
        references.map((reference) => {
          reads.push(reference.reference);
          return secretsByReference.get(reference.reference);
        }),
      ),
    invalidate: () => Effect.void,
  });
  return { reads, resolver };
}

it.effect(
  "replaces only the requested kind's credential references with the secrets they name",
  () =>
    Effect.gen(function* () {
      const { reads, resolver } = countingResolver();
      const resolved = yield* resolveSourceControlHostSecrets(resolver, hosts, "bitbucket");
      assert.deepEqual(resolved, {
        ...hosts,
        bitbucket: { email: "me@example.test", accessToken: "bb_from_provider" },
      });
      assert.deepEqual(reads, ["bitbucket#token"]);
    }),
);

it.effect("treats a reference the provider cannot read as an unset credential", () =>
  Effect.gen(function* () {
    const { reads, resolver } = countingResolver();
    const resolved = yield* resolveSourceControlHostSecrets(resolver, hosts, "gitcafe");
    assert.deepEqual(resolved.gitcafe, { token: "" });
    assert.deepEqual(reads, ["missing#token"]);
  }),
);

it.effect("leaves the resolver unused for a kind that holds no reference", () =>
  Effect.gen(function* () {
    const { reads, resolver } = countingResolver();
    const resolved = yield* resolveSourceControlHostSecrets(resolver, hosts, "github");
    assert.strictEqual(resolved, hosts);
    assert.deepEqual(reads, []);
  }),
);

it("collects the references held in credential fields and skips literal values", () => {
  assert.deepEqual(collectSourceControlHostSecretReferences(hosts), [
    source("missing#token"),
    source("bitbucket#token"),
  ]);
  assert.deepEqual(
    collectSourceControlHostSecretReferences({
      bitbucket: { accessToken: "literal" },
      github: { tokens: { "github.com": "ghp_literal" } },
    }),
    [],
  );
});

it.effect("reads a collected reference again once it is invalidated", () =>
  Effect.gen(function* () {
    let current = "stale";
    const cache = new Map<string, string>();
    const resolver = SecretResolver.SecretResolver.of({
      read: (references) =>
        Effect.sync(() =>
          references.map((reference) => {
            const hit = cache.get(reference.reference);
            if (hit !== undefined) return hit;
            cache.set(reference.reference, current);
            return current;
          }),
        ),
      invalidate: (references) =>
        Effect.sync(() => {
          if (references === undefined) cache.clear();
          else for (const reference of references) cache.delete(reference.reference);
        }),
    });
    const read = () => resolveSourceControlHostSecrets(resolver, hosts, "bitbucket");
    assert.deepEqual((yield* read()).bitbucket, {
      email: "me@example.test",
      accessToken: "stale",
    });
    current = "rotated";
    yield* invalidateSettingsSecrets(resolver, Effect.succeed({ sourceControlHosts: hosts }));
    assert.deepEqual((yield* read()).bitbucket, {
      email: "me@example.test",
      accessToken: "rotated",
    });
    current = "rotated again";
    yield* invalidateSettingsSecrets(resolver, Effect.fail("settings unreadable"));
    assert.deepEqual((yield* read()).bitbucket, {
      email: "me@example.test",
      accessToken: "rotated again",
    });
  }),
);
