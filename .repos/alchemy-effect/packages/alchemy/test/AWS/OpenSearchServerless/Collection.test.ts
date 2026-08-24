import * as AWS from "@/AWS";
import {
  AccessPolicy,
  Collection,
  SecurityPolicy,
} from "@/AWS/OpenSearchServerless";
import * as Test from "@/Test/Alchemy";
import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic, collision-free names (≤32 chars, lowercase) reused across the
// collection and the policies that must reference its resource pattern.
const COLLECTION_NAME = "alchemy-test-aoss";
const ENC_POLICY = "alchemy-aoss-enc";
const NET_POLICY = "alchemy-aoss-net";
const ACC_POLICY = "alchemy-aoss-acc";

const encryptionPolicy = {
  Rules: [
    { ResourceType: "collection", Resource: [`collection/${COLLECTION_NAME}`] },
  ],
  AWSOwnedKey: true,
};

const networkPolicy = [
  {
    Rules: [
      {
        ResourceType: "collection",
        Resource: [`collection/${COLLECTION_NAME}`],
      },
      {
        ResourceType: "dashboard",
        Resource: [`collection/${COLLECTION_NAME}`],
      },
    ],
    AllowFromPublic: true,
  },
];

const accessPolicy = (principalArn: string) => [
  {
    Rules: [
      {
        ResourceType: "index",
        Resource: [`index/${COLLECTION_NAME}/*`],
        Permission: ["aoss:*"],
      },
      {
        ResourceType: "collection",
        Resource: [`collection/${COLLECTION_NAME}`],
        Permission: ["aoss:*"],
      },
    ],
    Principal: [principalArn],
  },
];

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag that the SecurityPolicy/AccessPolicy read + delete paths depend
// on, and that batchGetCollection decodes the per-item error detail shape used
// to observe a missing collection.
test.provider(
  "typed error semantics on nonexistent policies and collections",
  () =>
    Effect.gen(function* () {
      const policyError = yield* Effect.flip(
        aoss.getSecurityPolicy({
          type: "encryption",
          name: "alchemy-nonexistent-probe",
        }),
      );
      expect(policyError._tag).toBe("ResourceNotFoundException");

      // batchGetCollection does not throw for a missing collection — it reports
      // it in collectionErrorDetails, which the Collection provider treats as
      // "not present".
      const batch = yield* aoss.batchGetCollection({
        names: ["alchemy-nonexistent-collection-probe"],
      });
      expect(batch.collectionDetails ?? []).toHaveLength(0);
      expect((batch.collectionErrorDetails ?? []).length).toBeGreaterThan(0);
    }),
);

// Security and access policies are FREE (no OCU cost) and provision instantly,
// so their full lifecycle runs ungated. This exercises the bulk of the
// SecurityPolicy and AccessPolicy providers (create, no-op, update-with-version
// -bump, delete, verify-gone) without touching a billed collection.
test.provider(
  "security + access policy lifecycle: create, update, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { Account } = yield* sts.getCallerIdentity({});
      const principal = `arn:aws:iam::${Account}:role/alchemy-test-aoss-role`;

      // Create all three policies.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const enc = yield* SecurityPolicy("Enc", {
            policyName: ENC_POLICY,
            type: "encryption",
            policy: encryptionPolicy,
            description: "alchemy test encryption policy",
          });
          const net = yield* SecurityPolicy("Net", {
            policyName: NET_POLICY,
            type: "network",
            policy: networkPolicy,
          });
          const acc = yield* AccessPolicy("Acc", {
            policyName: ACC_POLICY,
            policy: accessPolicy(principal),
          });
          return { enc, net, acc };
        }),
      );

      expect(created.enc.policyName).toBe(ENC_POLICY);
      expect(created.enc.type).toBe("encryption");
      expect(created.net.type).toBe("network");
      expect(created.acc.type).toBe("data");
      const initialNetVersion = created.net.policyVersion;

      // Out-of-band verification via distilled.
      const encObserved = yield* aoss.getSecurityPolicy({
        type: "encryption",
        name: ENC_POLICY,
      });
      expect(encObserved.securityPolicyDetail?.name).toBe(ENC_POLICY);
      const accObserved = yield* aoss.getAccessPolicy({
        type: "data",
        name: ACC_POLICY,
      });
      expect(accObserved.accessPolicyDetail?.name).toBe(ACC_POLICY);

      // No-op redeploy: policy version must not change.
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          const enc = yield* SecurityPolicy("Enc", {
            policyName: ENC_POLICY,
            type: "encryption",
            policy: encryptionPolicy,
            description: "alchemy test encryption policy",
          });
          const net = yield* SecurityPolicy("Net", {
            policyName: NET_POLICY,
            type: "network",
            policy: networkPolicy,
          });
          const acc = yield* AccessPolicy("Acc", {
            policyName: ACC_POLICY,
            policy: accessPolicy(principal),
          });
          return { enc, net, acc };
        }),
      );
      expect(noop.net.policyVersion).toBe(initialNetVersion);

      // Update the network policy document → new policy version.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const enc = yield* SecurityPolicy("Enc", {
            policyName: ENC_POLICY,
            type: "encryption",
            policy: encryptionPolicy,
            description: "alchemy test encryption policy",
          });
          const net = yield* SecurityPolicy("Net", {
            policyName: NET_POLICY,
            type: "network",
            policy: [
              {
                Rules: [
                  {
                    ResourceType: "collection",
                    Resource: [`collection/${COLLECTION_NAME}`],
                  },
                ],
                AllowFromPublic: true,
              },
            ],
          });
          const acc = yield* AccessPolicy("Acc", {
            policyName: ACC_POLICY,
            policy: accessPolicy(principal),
          });
          return { enc, net, acc };
        }),
      );
      expect(updated.net.policyVersion).not.toBe(initialNetVersion);

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertPolicyGone("encryption", ENC_POLICY);
      yield* assertPolicyGone("network", NET_POLICY);
      yield* assertAccessPolicyGone(ACC_POLICY);
    }),
  { timeout: 120_000 },
);

// A VECTORSEARCH collection is the vector store Bedrock Knowledge Bases require.
// Collections have a real-money OCU floor and take ~1-5 min to provision, so the
// full lifecycle is gated behind AWS_TEST_SLOW=1, destroys IMMEDIATELY, and
// verifies the collection is gone.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create VECTORSEARCH collection, verify ACTIVE, destroy, verify gone (AWS_TEST_SLOW=1)",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { Account } = yield* sts.getCallerIdentity({});
      const principal = `arn:aws:iam::${Account}:role/alchemy-test-aoss-role`;

      const { collection } = yield* stack.deploy(
        Effect.gen(function* () {
          // Encryption policy is a hard prerequisite for the collection.
          const enc = yield* SecurityPolicy("Enc", {
            policyName: ENC_POLICY,
            type: "encryption",
            policy: encryptionPolicy,
          });
          const net = yield* SecurityPolicy("Net", {
            policyName: NET_POLICY,
            type: "network",
            policy: networkPolicy,
          });
          const acc = yield* AccessPolicy("Acc", {
            policyName: ACC_POLICY,
            policy: accessPolicy(principal),
          });
          const collection = yield* Collection("Collection", {
            collectionName: COLLECTION_NAME,
            type: "VECTORSEARCH",
            standbyReplicas: "DISABLED",
            // Ensure the policies exist first (bindings/refs are unnecessary —
            // the encryption policy is matched by resource pattern — but keep
            // them referenced so the engine deploys them alongside).
            tags: { encPolicy: enc.policyName, netPolicy: net.policyName },
          });
          return { collection, acc };
        }),
      );

      expect(collection.collectionName).toBe(COLLECTION_NAME);
      expect(collection.type).toBe("VECTORSEARCH");
      expect(collection.collectionArn).toContain(":collection/");
      expect(collection.collectionId).toBeDefined();
      // The data-plane endpoint that a Bedrock Knowledge Base points at.
      expect(collection.collectionEndpoint).toContain("aoss.amazonaws.com");

      // Out-of-band verification via distilled: the collection is ACTIVE.
      const observed = yield* aoss.batchGetCollection({
        ids: [collection.collectionId],
      });
      const detail = observed.collectionDetails?.[0];
      expect(detail?.status).toBe("ACTIVE");
      expect(detail?.type).toBe("VECTORSEARCH");

      // Destroy immediately — collections meter OCUs while they exist — and
      // verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertCollectionGone(collection.collectionId);
    }),
  { timeout: 900_000 },
);

const assertPolicyGone = (type: "encryption" | "network", name: string) =>
  aoss.getSecurityPolicy({ type, name }).pipe(
    Effect.flip,
    Effect.map((e) => expect(e._tag).toBe("ResourceNotFoundException")),
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
    }),
  );

const assertAccessPolicyGone = (name: string) =>
  aoss.getAccessPolicy({ type: "data", name }).pipe(
    Effect.flip,
    Effect.map((e) => expect(e._tag).toBe("ResourceNotFoundException")),
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
    }),
  );

// Deletion is verified as INITIATED (status `DELETING`) or fully gone — full
// disappearance takes another ~1-2 min server-side.
const assertCollectionGone = (id: string) =>
  Effect.gen(function* () {
    const response = yield* aoss.batchGetCollection({ ids: [id] });
    const detail = response.collectionDetails?.[0];
    const status = detail?.status ?? "gone";
    if (status !== "gone" && status !== "DELETING") {
      return yield* Effect.fail(
        new Error(`Collection '${id}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );
