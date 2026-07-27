import * as NodeCrypto from "node:crypto";
import { KeyPair, KeyPairProvider } from "@/KeyPair";
import * as Provider from "@/Provider";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({
  providers: KeyPairProvider(),
  state: inMemoryState(),
});

const assertPemKeyPair = (attrs: {
  privateKey: Redacted.Redacted<string>;
  publicKey: string;
}) => {
  const priv = Redacted.value(attrs.privateKey);
  expect(priv).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  expect(priv).toMatch(/-----END PRIVATE KEY-----/);
  expect(attrs.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  expect(attrs.publicKey).toMatch(/-----END PUBLIC KEY-----/);
  // Node throws if the PEM is malformed.
  NodeCrypto.createPrivateKey(priv);
  NodeCrypto.createPublicKey(attrs.publicKey);
};

describe("Alchemy.KeyPair", () => {
  test.provider("mints an ed25519 keypair by default", (stack) =>
    Effect.gen(function* () {
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KeyPair("ed25519-default");
        }),
      );
      expect(attrs.algorithm).toBe("ed25519");
      assertPemKeyPair(attrs);
    }),
  );

  test.provider("mints an rsa keypair when requested", (stack) =>
    Effect.gen(function* () {
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KeyPair("rsa-key", {
            algorithm: "rsa",
            modulusLength: 2048,
          });
        }),
      );
      expect(attrs.algorithm).toBe("rsa");
      assertPemKeyPair(attrs);
    }),
  );

  test.provider("mints an ec keypair when requested", (stack) =>
    Effect.gen(function* () {
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KeyPair("ec-key", {
            algorithm: "ec",
            namedCurve: "P-256",
          });
        }),
      );
      expect(attrs.algorithm).toBe("ec");
      assertPemKeyPair(attrs);
    }),
  );

  test.provider("preserves the keypair across deploys", (stack) =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        return yield* KeyPair("stable-key");
      });

      const first = yield* stack.deploy(program);
      const second = yield* stack.deploy(program);

      expect(Redacted.value(second.privateKey)).toBe(
        Redacted.value(first.privateKey),
      );
      expect(second.publicKey).toBe(first.publicKey);
    }),
  );

  test.provider("list returns [] for the non-listable keypair", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KeyPair("list-key");
        }),
      );

      const provider = yield* Provider.findProvider(KeyPair);
      expect(yield* provider.list()).toEqual([]);

      yield* stack.destroy();
    }),
  );
});
