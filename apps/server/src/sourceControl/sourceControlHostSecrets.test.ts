import { assert, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveSettingsSecret } from "../secrets/settingsSecretValue.ts";
import {
  collectSourceControlHostSecretReferences,
  resolveSourceControlHostSecrets,
} from "./sourceControlHostSecrets.ts";

const source = (reference: string) => ({
  provider: SecretProviderId.make("homelab"),
  reference,
});

const secretsByReference = new Map([["bitbucket#token", "bb_from_provider"]]);

const layerResolver = Layer.succeed(SecretResolver.SecretResolver, {
  read: (references) =>
    Effect.succeed(references.map((reference) => secretsByReference.get(reference.reference))),
  invalidate: () => Effect.void,
});

const fakeResolver = SecretResolver.SecretResolver.use((resolver) => Effect.succeed(resolver));

const hosts = {
  bitbucket: { email: "me@example.test", accessToken: source("bitbucket#token") },
  gitcafe: { token: source("missing#token") },
  github: { tokens: { "github.com": "ghp_literal" } },
};

const countingResolver = Effect.gen(function* () {
  const resolver = yield* fakeResolver;
  const reads: Array<string> = [];
  const resolve = (value: Parameters<typeof resolveSettingsSecret>[1]) =>
    Effect.sync(() => {
      if (typeof value !== "string") reads.push(value.reference);
    }).pipe(Effect.andThen(resolveSettingsSecret(resolver, value)));
  return { reads, resolve };
});

it.effect(
  "replaces only the requested kind's credential references with the secrets they name",
  () =>
    Effect.gen(function* () {
      const { reads, resolve } = yield* countingResolver;
      const resolved = yield* resolveSourceControlHostSecrets(hosts, "bitbucket", resolve);
      assert.deepEqual(resolved, {
        ...hosts,
        bitbucket: { email: "me@example.test", accessToken: "bb_from_provider" },
      });
      assert.deepEqual(reads, ["bitbucket#token"]);
    }).pipe(Effect.provide(layerResolver)),
);

it.effect("treats a reference the provider cannot read as an unset credential", () =>
  Effect.gen(function* () {
    const { reads, resolve } = yield* countingResolver;
    const resolved = yield* resolveSourceControlHostSecrets(hosts, "gitcafe", resolve);
    assert.deepEqual(resolved.gitcafe, { token: "" });
    assert.deepEqual(reads, ["missing#token"]);
  }).pipe(Effect.provide(layerResolver)),
);

it.effect("leaves the resolver unused for a kind that holds no reference", () =>
  Effect.gen(function* () {
    const { reads, resolve } = yield* countingResolver;
    const resolved = yield* resolveSourceControlHostSecrets(hosts, "github", resolve);
    assert.strictEqual(resolved, hosts);
    assert.deepEqual(reads, []);
  }).pipe(Effect.provide(layerResolver)),
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
          for (const reference of references ?? []) cache.delete(reference.reference);
        }),
    });
    const read = () =>
      resolveSourceControlHostSecrets(hosts, "bitbucket", (reference) =>
        resolveSettingsSecret(resolver, reference),
      );
    assert.deepEqual((yield* read()).bitbucket, {
      email: "me@example.test",
      accessToken: "stale",
    });
    current = "rotated";
    yield* resolver.invalidate(collectSourceControlHostSecretReferences(hosts));
    assert.deepEqual((yield* read()).bitbucket, {
      email: "me@example.test",
      accessToken: "rotated",
    });
  }),
);
