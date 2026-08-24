import * as AWS from "@/AWS";
import { KeyPair } from "@/AWS/EC2/KeyPair.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { assertKeyPairGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Create a generated key pair, assert the private key is captured, verify it
// exists out-of-band, then destroy it and confirm it is gone.
test.provider(
  "create generates a key pair and captures the private key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const keyPair = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* KeyPair("GeneratedKey", { keyType: "ed25519" });
        }),
      );

      expect(keyPair.keyPairId).toMatch(/^key-/);
      expect(keyPair.keyName).toBeTruthy();
      expect(keyPair.keyType).toBe("ed25519");
      expect(keyPair.keyFingerprint).toBeTruthy();
      // AWS returns the private key exactly once, at create time.
      expect(keyPair.privateKey).toBeDefined();
      expect(Redacted.value(keyPair.privateKey!)).toContain("PRIVATE KEY");

      // Verify out-of-band.
      const described = yield* ec2.describeKeyPairs({
        KeyPairIds: [keyPair.keyPairId],
      });
      expect(described.KeyPairs?.[0]?.KeyName).toBe(keyPair.keyName);
      expect(described.KeyPairs?.[0]?.KeyType).toBe("ed25519");

      yield* stack.destroy();

      // Confirm deletion.
      const after = yield* ec2
        .describeKeyPairs({ KeyNames: [keyPair.keyName] })
        .pipe(
          Effect.catchTag("InvalidKeyPair.NotFound", () =>
            Effect.succeed({ KeyPairs: [] }),
          ),
        );
      expect(after.KeyPairs ?? []).toHaveLength(0);
    }),
);

// `list()` enumerates branded key pairs in the account.
test.provider("list enumerates the deployed key pair", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const keyPair = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* KeyPair("ListKey", {});
      }),
    );

    const provider = yield* Provider.findProvider(KeyPair);
    const all = yield* provider.list();
    expect(all.some((k) => k.keyPairId === keyPair.keyPairId)).toBe(true);

    yield* stack.destroy();

    yield* assertKeyPairGone(keyPair.keyPairId);
  }),
);
