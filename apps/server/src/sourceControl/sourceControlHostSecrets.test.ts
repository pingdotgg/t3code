import { assert, it } from "@effect/vitest";
import { SecretProviderId } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { resolveSourceControlHostSecrets } from "./sourceControlHostSecrets.ts";

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

it.effect("replaces credential references with the secrets they name", () =>
  Effect.gen(function* () {
    const resolver = yield* fakeResolver;
    const hosts = {
      bitbucket: { email: "me@example.test", accessToken: source("bitbucket#token") },
      gitcafe: { token: source("missing#token") },
    };
    const resolved = yield* resolveSourceControlHostSecrets(hosts, (value) =>
      resolveSettingsSecret(resolver, value),
    );
    assert.deepEqual(resolved, {
      bitbucket: { email: "me@example.test", accessToken: "bb_from_provider" },
      gitcafe: { token: "" },
    });
  }).pipe(Effect.provide(layerResolver)),
);

it.effect("hands back the same settings when no credential names a secret", () =>
  Effect.gen(function* () {
    const resolver = yield* fakeResolver;
    const hosts = { gitcafe: { token: "literal" } };
    const resolved = yield* resolveSourceControlHostSecrets(hosts, (value) =>
      resolveSettingsSecret(resolver, value),
    );
    assert.strictEqual(resolved, hosts);
  }).pipe(Effect.provide(layerResolver)),
);
