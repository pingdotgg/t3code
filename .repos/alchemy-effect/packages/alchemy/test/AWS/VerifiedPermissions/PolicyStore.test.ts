import * as AWS from "@/AWS";
import { Policy, PolicyStore, Schema } from "@/AWS/VerifiedPermissions";
import * as Test from "@/Test/Alchemy";
import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const unwrap = (v: string | Redacted.Redacted<string> | undefined) =>
  v === undefined ? undefined : Redacted.isRedacted(v) ? Redacted.value(v) : v;

const { test } = Test.make({ providers: AWS.providers() });

const findStore = (policyStoreId: string) =>
  avp
    .getPolicyStore({ policyStoreId, tags: true })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const findPolicy = (policyStoreId: string, policyId: string) =>
  avp
    .getPolicy({ policyStoreId, policyId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const findSchema = (policyStoreId: string) =>
  avp
    .getSchema({ policyStoreId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

class StoreStillExists extends Data.TaggedError("StoreStillExists")<{
  readonly policyStoreId: string;
}> {}

const assertStoreDeleted = (policyStoreId: string) =>
  findStore(policyStoreId).pipe(
    Effect.flatMap((store) =>
      store === undefined
        ? Effect.void
        : Effect.fail(new StoreStillExists({ policyStoreId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "StoreStillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

const cedarSchema = JSON.stringify({
  PhotoApp: {
    entityTypes: {
      User: {},
      Photo: {},
    },
    actions: {
      viewPhoto: {
        appliesTo: {
          principalTypes: ["User"],
          resourceTypes: ["Photo"],
        },
      },
    },
  },
});

test.provider(
  "policy store lifecycle: create store + schema + policy, update validation mode + policy statement, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // AVP forbids changing a static policy's principal/resource SCOPE on
      // update — only the description and conditions may change. Keep the
      // scope fixed and vary the policy description across deploys.
      const statement = `permit(
        principal == PhotoApp::User::"alice",
        action == PhotoApp::Action::"viewPhoto",
        resource
      );`;

      const makeStack = (
        validationMode: "OFF" | "STRICT",
        description: string,
        policyDescription: string,
      ) =>
        Effect.gen(function* () {
          const store = yield* PolicyStore("Store", {
            validationMode,
            description,
            deletionProtection: "DISABLED",
            tags: { Environment: "test" },
          });
          const schema = yield* Schema("Schema", {
            policyStoreId: store.policyStoreId,
            cedarJson: cedarSchema,
          });
          const policy = yield* Policy("AllowUser", {
            // depend on the schema so, under STRICT validation, the policy is
            // created after PutSchema — Cedar validates the statement against
            // the schema at CreatePolicy time
            policyStoreId: schema.policyStoreId,
            statement,
            description: policyDescription,
          });
          return { store, schema, policy };
        });

      // create: STRICT validation requires the schema to be present
      const { store, policy } = yield* stack.deploy(
        makeStack("STRICT", "photo app", "initial policy"),
      );
      expect(store.policyStoreId).toBeDefined();
      expect(store.policyStoreArn).toContain(":policy-store/");
      expect(policy.policyId).toBeDefined();
      expect(policy.policyStoreId).toBe(store.policyStoreId);

      // out-of-band verify
      const created = yield* findStore(store.policyStoreId);
      expect(created?.validationSettings.mode).toBe("STRICT");
      expect(unwrap(created?.description)).toBe("photo app");
      expect(created?.tags?.Environment).toBe("test");
      expect(created?.tags?.["alchemy::id"]).toBe("Store");

      const createdSchema = yield* findSchema(store.policyStoreId);
      expect(unwrap(createdSchema?.schema)).toContain("PhotoApp");

      const createdPolicy = yield* findPolicy(
        store.policyStoreId,
        policy.policyId,
      );
      expect(createdPolicy?.policyType).toBe("STATIC");

      // update: store validation mode OFF + description, and the policy's
      // description in place (policyId is stable)
      const updated = yield* stack.deploy(
        makeStack("OFF", "updated app", "updated policy"),
      );
      expect(updated.store.policyStoreId).toBe(store.policyStoreId);
      expect(updated.policy.policyId).toBe(policy.policyId);

      const afterUpdate = yield* findStore(store.policyStoreId);
      expect(afterUpdate?.validationSettings.mode).toBe("OFF");
      expect(unwrap(afterUpdate?.description)).toBe("updated app");

      // destroy
      yield* stack.destroy();
      yield* assertStoreDeleted(store.policyStoreId);
    }),
  { timeout: 180_000 },
);
