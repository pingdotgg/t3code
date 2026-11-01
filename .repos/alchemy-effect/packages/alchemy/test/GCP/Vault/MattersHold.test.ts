import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vault from "@distilled.cloud/gcp/vault_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, runAccountLifecycle, vaultAccount } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (matterId: string, holdId: string) =>
  vault.getMattersHolds({ matterId, holdId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getMattersHolds on a missing hold fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vault.getMattersHolds({
          matterId: "alchemy-missing-matter",
          holdId: "alchemy-missing-hold",
        }),
      );
      expect(error._tag).toEqual("VaultScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.GCP_TEST_VAULT)(
  "createMattersHolds without Vault access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vault.createMattersHolds({
          matterId: "alchemy-missing-matter",
          body: {
            name: "Alchemy Vault Hold Probe",
            corpus: "MAIL",
            accounts: [{ email: "probe@example.com" }],
          },
        }),
      );
      expect(error._tag).toEqual("VaultScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runAccountLifecycle)(
  "create, update, and delete a hold",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const email = vaultAccount ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const matter = yield* GCP.Vault.Matter("HoldCase", {
            name: "Hold Case",
            description: "hold parent",
          });
          const hold = yield* GCP.Vault.MattersHold("Mail", {
            matterId: matter.matterId,
            name: "Mail hold",
            corpus: "MAIL",
            accounts: [{ email }],
            query: { mailQuery: { terms: "subject:alchemy" } },
          });
          return { matter, hold };
        }),
      );

      expect(created.hold.holdId.length).toBeGreaterThan(0);
      expect(created.hold.matterId).toEqual(created.matter.matterId);
      expect(created.hold.name).toEqual("Mail hold");
      expect(created.hold.corpus).toEqual("MAIL");

      const fetched = yield* vault.getMattersHolds({
        matterId: created.hold.matterId,
        holdId: created.hold.holdId,
        view: "FULL_HOLD",
      });
      expect(fetched.holdId).toEqual(created.hold.holdId);
      expect(fetched.name).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const matter = yield* GCP.Vault.Matter("HoldCase", {
            matterId: created.matter.matterId,
            name: "Hold Case",
            description: "hold parent",
          });
          const hold = yield* GCP.Vault.MattersHold("Mail", {
            matterId: matter.matterId,
            holdId: created.hold.holdId,
            name: "Mail hold",
            corpus: "MAIL",
            accounts: [{ email }],
            query: { mailQuery: { terms: "subject:alchemy 2026" } },
          });
          return hold;
        }),
      );

      expect(updated.holdId).toEqual(created.hold.holdId);
      expect(updated.query?.mailQuery?.terms).toEqual("subject:alchemy 2026");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.hold.matterId,
        created.hold.holdId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);
