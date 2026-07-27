import * as AWS from "@/AWS";
import { PolicyStore, PolicyStoreAlias } from "@/AWS/VerifiedPermissions";
import * as Test from "@/Test/Alchemy";
import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const findAlias = (aliasName: string) =>
  avp
    .getPolicyStoreAlias({ aliasName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

// CreatePolicyStoreAlias currently rejects every alias name shape with a
// typed ValidationException in this account/region (probed 2026-07-15 with
// hyphenated, plain, underscore, slash, and mixed-case names — all fail with
// "Invalid input"). The API appears not yet generally available. This
// ungated probe pins the typed error; the full lifecycle below is gated
// behind AWS_TEST_POLICY_STORE_ALIAS=1 so an enabled account can run it
// unchanged.
test.provider(
  "createPolicyStoreAlias surfaces a typed ValidationException (API not yet available)",
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
  { timeout: 120_000 },
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
      expect(alias.aliasName).toBeDefined();
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
  { timeout: 180_000 },
);
