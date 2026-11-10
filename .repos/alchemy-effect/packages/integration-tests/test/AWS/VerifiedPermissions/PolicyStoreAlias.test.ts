import * as AWS from "@alchemy.run/aws";
import { PolicyStore, PolicyStoreAlias } from "@alchemy.run/aws/VerifiedPermissions";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const findAlias = (aliasName: string) =>
  avp
    .getPolicyStoreAlias({ aliasName })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));

// AWS requires every alias name to be prefixed with `policy-store-alias/`.
// The 2026-07-15 probes that concluded the API was "not yet available" all
// used bare names (hyphenated, plain, underscore, slash, mixed-case), which
// fail with "Invalid input" — the provider now always applies the prefix.
// This ungated probe pins that a bare name surfaces a typed
// ValidationException. The full lifecycle below is still gated behind
// AWS_TEST_POLICY_STORE_ALIAS=1 until it has been confirmed green against a
// live account.
test.provider(
  "createPolicyStoreAlias rejects an alias name without the policy-store-alias/ prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { store } = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* PolicyStore("Store", {
            validationMode: "OFF",
          });
          return { store };
        }),
      );
      const result = yield* Effect.result(
        avp.createPolicyStoreAlias({
          aliasName: "alchemy-probe-alias",
          policyStoreId: store.policyStoreId,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ValidationException");
      }
      yield* stack.destroy();
    }),
  {
    tags: ["provider:aws", "provider:aws:verifiedpermissions", "live"],
    timeout: 120_000,
  },
);

test.provider.skipIf(!process.env.AWS_TEST_POLICY_STORE_ALIAS)(
  "policy store alias lifecycle: create with generated name, verify, destroy (hard delete)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = Effect.gen(function* () {
        const store = yield* PolicyStore("Store", { validationMode: "OFF" });
        const alias = yield* PolicyStoreAlias("Alias", {
          policyStoreId: store.policyStoreId,
          // HardDelete frees the generated name immediately so repeated test
          // runs never collide with a PendingDeletion alias
          deletionMode: "HardDelete",
        });
        return { store, alias };
      });

      // create
      const { store, alias } = yield* stack.deploy(makeStack);
      expect(alias.aliasName.startsWith("policy-store-alias/")).toBe(true);
      expect(alias.aliasArn).toContain(":policy-store-alias/");
      expect(alias.policyStoreId).toBe(store.policyStoreId);

      // out-of-band verify
      const created = yield* findAlias(alias.aliasName);
      expect(created?.policyStoreId).toBe(store.policyStoreId);
      expect(created?.state).toBe("Active");

      // idempotent redeploy — same alias, no replacement
      const redeployed = yield* stack.deploy(makeStack);
      expect(redeployed.alias.aliasName).toBe(alias.aliasName);
      expect(redeployed.alias.aliasArn).toBe(alias.aliasArn);

      // destroy
      yield* stack.destroy();
      const gone = yield* findAlias(alias.aliasName);
      expect(gone).toBeUndefined();
    }),
  {
    tags: ["provider:aws", "provider:aws:verifiedpermissions", "live"],
    timeout: 180_000,
  },
);
