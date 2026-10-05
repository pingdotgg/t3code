import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vault from "@distilled.cloud/gcp/vault_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  logLevel,
  runAccountLifecycle,
  sampleMailExportOptions,
  sampleMailQuery,
  vaultAccount,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (matterId: string, exportId: string) =>
  vault.getMattersExports({ matterId, exportId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getMattersExports on a missing export fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vault.getMattersExports({
          matterId: "alchemy-missing-matter",
          exportId: "alchemy-missing-export",
        }),
      );
      expect(error._tag).toEqual("VaultScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.GCP_TEST_VAULT)(
  "createMattersExports without Vault access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vault.createMattersExports({
          matterId: "alchemy-missing-matter",
          body: {
            name: "Alchemy Vault Export Probe",
            query: sampleMailQuery("probe@example.com"),
            exportOptions: sampleMailExportOptions(),
          },
        }),
      );
      expect(error._tag).toEqual("VaultScopeInsufficient");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runAccountLifecycle)(
  "create and delete an export",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const email = vaultAccount ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const matter = yield* GCP.Vault.Matter("ExportCase", {
            name: "Export Case",
            description: "export parent",
          });
          const exported = yield* GCP.Vault.MattersExport("Mail", {
            matterId: matter.matterId,
            name: "mail-dump",
            query: sampleMailQuery(email),
            exportOptions: sampleMailExportOptions(),
          });
          return { matter, exported };
        }),
      );

      expect(created.exported.exportId.length).toBeGreaterThan(0);
      expect(created.exported.matterId).toEqual(created.matter.matterId);
      expect(created.exported.name).toEqual("mail-dump");

      const fetched = yield* vault.getMattersExports({
        matterId: created.exported.matterId,
        exportId: created.exported.exportId,
      });
      expect(fetched.id).toEqual(created.exported.exportId);
      expect(fetched.name).toContain("[alchemy ");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.exported.matterId,
        created.exported.exportId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:vault", "live"], timeout: 90_000 },
);
