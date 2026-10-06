import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vault from "@distilled.cloud/gcp/vault_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (matterId: string) =>
  vault.getMatters({ matterId }).pipe(
    Effect.map((matter) =>
      matter.state === "DELETED" ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getMatters on a missing matter fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vault.getMatters({ matterId: "alchemy-missing-matter" }),
      );
      expect(error._tag).toEqual("VaultScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.GCP_TEST_VAULT)(
  "createMatters without the Vault OAuth scope fails with VaultScopeInsufficient",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vault.createMatters({
          body: {
            name: "Alchemy Vault Probe",
            description: "alchemy probe",
          },
        }),
      );
      expect(error._tag).toEqual("VaultScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a matter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vault.Matter("Case", {
            name: "Acme v Contoso",
            description: "litigation hold",
          });
        }),
      );

      expect(created.matterId.length).toBeGreaterThan(0);
      expect(created.name).toEqual("Acme v Contoso");
      expect(created.description).toEqual("litigation hold");
      expect(created.state).toEqual("OPEN");

      const fetched = yield* vault.getMatters({
        matterId: created.matterId,
        view: "FULL",
      });
      expect(fetched.matterId).toEqual(created.matterId);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vault.Matter("Case", {
            matterId: created.matterId,
            name: "Acme v Contoso 2026",
            description: "litigation hold extended",
          });
        }),
      );

      expect(updated.matterId).toEqual(created.matterId);
      expect(updated.name).toEqual("Acme v Contoso 2026");
      expect(updated.description).toEqual("litigation hold extended");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.matterId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);
