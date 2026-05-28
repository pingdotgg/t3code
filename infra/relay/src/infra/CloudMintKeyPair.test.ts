import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import {
  CloudMintKeyPair,
  CloudMintKeyPairProvider,
  makeCloudMintKeyPair,
} from "./CloudMintKeyPair.ts";

const { test } = Test.make({
  providers: CloudMintKeyPairProvider(),
  stage: "cloud-mint-keypair-test",
});

describe("CloudMintKeyPair", () => {
  it.effect("generates an Ed25519 PEM key pair usable for relay mint signatures", () =>
    Effect.gen(function* () {
      const keyPair = yield* makeCloudMintKeyPair;
      const payload = Buffer.from("relay mint proof");
      const signature = NodeCrypto.sign(null, payload, Redacted.value(keyPair.privateKey));

      expect(Redacted.value(keyPair.privateKey)).toContain("BEGIN PRIVATE KEY");
      expect(Redacted.value(keyPair.publicKey)).toContain("BEGIN PUBLIC KEY");
      expect(NodeCrypto.verify(null, payload, Redacted.value(keyPair.publicKey), signature)).toBe(
        true,
      );
    }),
  );
});

test.provider("preserves the Alchemy-owned cloud mint keypair across deploys", (stack) =>
  Effect.gen(function* () {
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - Alchemy's test scratch stack exposes provider failures as framework-owned any.
    const first = yield* stack.deploy(CloudMintKeyPair("CloudMintKeyPair"));
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - Alchemy's test scratch stack exposes provider failures as framework-owned any.
    const second = yield* stack.deploy(CloudMintKeyPair("CloudMintKeyPair"));
    const payload = Buffer.from("relay mint provider proof");
    const signature = NodeCrypto.sign(null, payload, Redacted.value(second.privateKey));

    expect(Redacted.value(second.privateKey)).toBe(Redacted.value(first.privateKey));
    expect(Redacted.value(second.publicKey)).toBe(Redacted.value(first.publicKey));
    expect(NodeCrypto.verify(null, payload, Redacted.value(second.publicKey), signature)).toBe(
      true,
    );
  }),
);
