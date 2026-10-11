import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vault from "@distilled.cloud/gcp/vault_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  logLevel,
  runAccountLifecycle,
  sampleMailQuery,
  vaultAccount,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (matterId: string, savedQueryId: string) =>
  vault.getMattersSavedQueries({ matterId, savedQueryId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getMattersSavedQueries on a missing saved query fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vault.getMattersSavedQueries({
          matterId: "alchemy-missing-matter",
          savedQueryId: "alchemy-missing-query",
        }),
      );
      expect(error._tag).toEqual("VaultScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.GCP_TEST_VAULT)(
  "createMattersSavedQueries without Vault access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vault.createMattersSavedQueries({
          matterId: "alchemy-missing-matter",
          body: {
            displayName: "Alchemy Vault Saved Query Probe",
            query: sampleMailQuery("probe@example.com"),
          },
        }),
      );
      expect(error._tag).toEqual("VaultScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runAccountLifecycle)(
  "create and delete a saved query",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const email = vaultAccount ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const matter = yield* GCP.Vault.Matter("QueryCase", {
            name: "Query Case",
            description: "saved query parent",
          });
          const saved = yield* GCP.Vault.MattersSavedQuery("Contracts", {
            matterId: matter.matterId,
            displayName: "contracts",
            query: sampleMailQuery(email),
          });
          return { matter, saved };
        }),
      );

      expect(created.saved.savedQueryId.length).toBeGreaterThan(0);
      expect(created.saved.matterId).toEqual(created.matter.matterId);
      expect(created.saved.displayName).toEqual("contracts");

      const fetched = yield* vault.getMattersSavedQueries({
        matterId: created.saved.matterId,
        savedQueryId: created.saved.savedQueryId,
      });
      expect(fetched.savedQueryId).toEqual(created.saved.savedQueryId);
      expect(fetched.displayName).toContain("[alchemy ");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.saved.matterId,
        created.saved.savedQueryId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);
