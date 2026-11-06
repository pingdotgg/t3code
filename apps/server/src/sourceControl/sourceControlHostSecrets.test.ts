import { assert, it } from "@effect/vitest";
import { DeviceHostId, SecretProviderId, UsageLimitSourceId } from "@t3tools/contracts";
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

const secretsByReference = new Map([
  ["bitbucket#token", "bb_from_provider"],
  ["github#token", "ghp_from_provider"],
]);

const perHostHosts = {
  github: { tokens: { "github.com": source("github#token"), "ghe.acme.test": "ghp_literal" } },
};

const hosts = {
  bitbucket: { email: "me@example.test", accessToken: source("bitbucket#token") },
  gitcafe: { token: source("missing#token") },
  github: { tokens: { "github.com": "ghp_literal" } },
};

function countingResolver() {
  const reads: Array<string> = [];
  const resolver = SecretResolver.SecretResolver.of({
    label: (provider) => Effect.succeed(provider),
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

it.effect("keeps a reference the provider cannot read, so it never passes for an unset one", () =>
  Effect.gen(function* () {
    const { reads, resolver } = countingResolver();
    const resolved = yield* resolveSourceControlHostSecrets(resolver, hosts, "gitcafe");
    assert.deepEqual(resolved.gitcafe, { token: source("missing#token") });
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

it.effect("replaces a per-host token reference and keeps the literal beside it", () =>
  Effect.gen(function* () {
    const { reads, resolver } = countingResolver();
    const resolved = yield* resolveSourceControlHostSecrets(resolver, perHostHosts, "github");
    assert.deepEqual(resolved, {
      github: { tokens: { "github.com": "ghp_from_provider", "ghe.acme.test": "ghp_literal" } },
    });
    assert.deepEqual(reads, ["github#token"]);
  }),
);

it("collects the references held in credential fields and skips literal values", () => {
  assert.deepEqual(collectSourceControlHostSecretReferences(hosts), [
    source("missing#token"),
    source("bitbucket#token"),
  ]);
  assert.deepEqual(collectSourceControlHostSecretReferences(perHostHosts), [
    source("github#token"),
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
      label: (provider) => Effect.succeed(provider),
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
    const usageLimitSources = {
      [UsageLimitSourceId.make("referenced")]: {
        kind: "cliproxy",
        url: "https://hub.test",
        managementKey: source("cliproxy#key"),
        enabled: true,
      },
      [UsageLimitSourceId.make("literal")]: {
        kind: "cliproxy",
        url: "https://hub.test",
        managementKey: "plain-key",
        enabled: true,
      },
    } as const;
    const easDeviceHosts = [
      {
        kind: "eas" as const,
        id: DeviceHostId.make("ref"),
        label: "Ref",
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 2,
        accessToken: source("expo#token"),
      },
    ];
    const simlockDeviceHosts = [
      {
        kind: "simlock" as const,
        id: DeviceHostId.make("pool"),
        label: "Pool",
        gatewayUrl: "https://simlock.test:4700",
        agentToken: source("simlock#token"),
        maxLeases: 2,
        maxLeaseMinutes: 60,
      },
    ];
    cache.set("cliproxy#key", "stale");
    cache.set("voice#key", "stale");
    cache.set("expo#token", "stale");
    cache.set("simlock#token", "stale");
    assert.deepEqual((yield* read()).bitbucket, {
      email: "me@example.test",
      accessToken: "stale",
    });
    current = "rotated";
    yield* invalidateSettingsSecrets(
      resolver,
      Effect.succeed({
        sourceControlHosts: hosts,
        cloudSpeechCredentials: { openai: source("voice#key"), xai: "", openrouter: "" },
        usageLimitSources,
        easDeviceHosts,
        simlockDeviceHosts,
      }),
    );
    assert.isFalse(cache.has("cliproxy#key"));
    assert.isFalse(cache.has("voice#key"));
    assert.isFalse(cache.has("expo#token"));
    assert.isFalse(cache.has("simlock#token"));
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
