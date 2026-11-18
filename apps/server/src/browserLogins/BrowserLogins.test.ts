import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import {
  defineSecretProviderDriver,
  type SecretProviderLoginDetail,
} from "@t3tools/secret-provider-core/server/driver";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as Settings from "../serverSettings.ts";
import * as BrowserLogins from "./BrowserLogins.ts";

describe("loginMatchesOrigin", () => {
  it.each([
    ["https://acme.test/login", "https://acme.test", true],
    ["acme.test", "https://acme.test", true],
    ["https://app.acme.test", "https://acme.test", false],
    ["https://acme.test", "https://app.acme.test", false],
    ["https://acme.test:8443", "https://acme.test", false],
    ["http://acme.test", "http://acme.test", false],
    ["http://acme.test", "https://acme.test", false],
    ["http://localhost:3000/sign-in", "http://localhost:3000", true],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000", true],
    ["http://[::1]:3000", "http://[::1]:3000", true],
    ["http://localhost:3001", "http://localhost:3000", false],
  ])("%s on %s is %s", (url, origin, matches) => {
    assert.strictEqual(BrowserLogins.loginMatchesOrigin([url], origin), matches);
  });
});

const KIND = SecretProviderKind.make("fake");
const provider = SecretProviderId.make("work");
const acme: SecretProviderLoginDetail = {
  id: "acme",
  title: "Acme",
  urls: ["https://acme.test/login"],
  fields: { username: "fake://acme/username", otp: "fake://acme/otp" },
};

const fakeLogins = () => {
  const reads: Array<string> = [];
  let code = 0;
  const driver = defineSecretProviderDriver({
    kind: KIND,
    definition: defineSecretProvider({
      kind: KIND,
      label: "Fake",
      configSchema: Schema.Struct({}),
      isReference: (reference) => reference.startsWith("fake://"),
      referencePlaceholder: "fake://item",
      invalidReferenceMessage: "Use fake://item.",
    }),
    read: (_config, references) =>
      Effect.sync(() => {
        reads.push(...references);
        return references.map((reference) =>
          reference.endsWith("/otp") ? String(++code).padStart(6, "0") : "ada@acme.test",
        );
      }),
    logins: {
      vaults: () => Effect.succeedSome([{ id: "v1", name: "Agents" }]),
      list: () =>
        Effect.succeed([acme, { id: "other", title: "Other", urls: ["https://other.test"] }]),
      get: (_config, _vault, itemId) => Effect.succeed({ ...acme, id: itemId }),
    },
  });
  const layer = Layer.effect(
    BrowserLogins.BrowserLogins,
    BrowserLogins.make({ drivers: [driver] }),
  ).pipe(
    Layer.provide(
      Settings.ServerSettingsService.layerTest({
        secretProviders: { [provider]: { kind: KIND, label: "Work", config: {} } },
        browserLogins: { provider, vault: "Agents" },
      }),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { layer, reads };
};

describe("BrowserLogins", () => {
  it.effect("lists only the page origin's logins, with the fields they can fill", () => {
    const fake = fakeLogins();
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      assert.deepStrictEqual(yield* logins.list({ tabUrl: "https://acme.test/login?next=/" }), {
        origin: "https://acme.test",
        logins: [
          {
            id: "acme",
            title: "Acme",
            urls: ["https://acme.test/login"],
            fields: ["username", "otp"],
          },
        ],
      });
      assert.deepStrictEqual(yield* logins.list({ tabUrl: "http://acme.test/login" }), {
        origin: null,
        logins: [],
      });
      assert.deepStrictEqual(fake.reads, []);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("reads every fill fresh and refuses another origin or a missing field", () => {
    const fake = fakeLogins();
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const otp = { itemId: "acme", field: "otp", origin: "https://acme.test" } as const;
      const first = yield* logins.secretFor(otp);
      const second = yield* logins.secretFor(otp);
      assert.deepStrictEqual([Redacted.value(first), Redacted.value(second)], ["000001", "000002"]);
      assert.deepStrictEqual(fake.reads, ["fake://acme/otp", "fake://acme/otp"]);

      const reason = (input: Parameters<typeof logins.secretFor>[0]) =>
        logins.secretFor(input).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      assert.strictEqual(yield* reason({ ...otp, origin: "https://evil.test" }), "originMismatch");
      assert.strictEqual(yield* reason({ ...otp, field: "password" }), "fieldMissing");
      assert.strictEqual(fake.reads.length, 2);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("checks a provider and vault before they are saved, without reading a value", () => {
    const fake = fakeLogins();
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      assert.deepStrictEqual(yield* logins.check({ provider, vault: "Other" }), { logins: 2 });
      assert.deepStrictEqual(yield* logins.vaults({ provider }), {
        vaults: [{ id: "v1", name: "Agents" }],
      });
      const missing = SecretProviderId.make("missing");
      assert.strictEqual(
        (yield* Effect.flip(logins.check({ provider: missing, vault: "Agents" }))).reason,
        "notConfigured",
      );
      assert.deepStrictEqual(fake.reads, []);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("is off until browserLogins names a provider", () =>
    Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const error = yield* Effect.flip(logins.list({ tabUrl: "https://acme.test" }));
      assert.strictEqual(error.reason, "notConfigured");
    }).pipe(
      Effect.provide(
        Layer.effect(BrowserLogins.BrowserLogins, BrowserLogins.make({ drivers: [] })).pipe(
          Layer.provide(Settings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
