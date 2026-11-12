import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SecretProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { defineSecretProviderDriver, type SecretProviderDriver } from "./driver.ts";
import * as SecretProviderConfigChoices from "./SecretProviderConfigChoices.ts";
import { defineSecretProvider } from "../shared/definition.ts";

const FAKE_KIND = SecretProviderKind.make("fake");
const choices = [{ value: "a", label: "acme", description: "me@acme.example" }];

const fakeDriver = (listConfigChoices?: SecretProviderDriver["listConfigChoices"]) =>
  defineSecretProviderDriver({
    kind: FAKE_KIND,
    definition: defineSecretProvider({
      kind: FAKE_KIND,
      label: "Fake",
      configSchema: Schema.Struct({ account: Schema.String }),
      isReference: () => true,
      referencePlaceholder: "fake://item",
      invalidReferenceMessage: "Use fake://item.",
    }),
    read: (_config, references) => Effect.succeed(references.map(() => undefined)),
    ...(listConfigChoices === undefined ? {} : { listConfigChoices }),
  });

const layerFor = (driver: SecretProviderDriver) =>
  SecretProviderConfigChoices.layer({ drivers: [driver] }).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

describe("SecretProviderConfigChoices", () => {
  it.effect("asks the registered driver for the field", () =>
    Effect.gen(function* () {
      const service = yield* SecretProviderConfigChoices.SecretProviderConfigChoices;
      assert.deepStrictEqual(yield* service.list(FAKE_KIND, "account"), choices);
      assert.deepStrictEqual(yield* service.list(FAKE_KIND, "vault"), []);
    }).pipe(
      Effect.provide(
        layerFor(fakeDriver((field) => Effect.succeed(field === "account" ? choices : []))),
      ),
    ),
  );

  it.effect("is empty for an unknown kind", () =>
    Effect.gen(function* () {
      const service = yield* SecretProviderConfigChoices.SecretProviderConfigChoices;
      assert.deepStrictEqual(
        yield* service.list(SecretProviderKind.make("unknown"), "account"),
        [],
      );
    }).pipe(Effect.provide(layerFor(fakeDriver(() => Effect.succeed(choices))))),
  );

  it.effect("is empty for a driver without the capability", () =>
    Effect.gen(function* () {
      const service = yield* SecretProviderConfigChoices.SecretProviderConfigChoices;
      assert.deepStrictEqual(yield* service.list(FAKE_KIND, "account"), []);
    }).pipe(Effect.provide(layerFor(fakeDriver()))),
  );
});
