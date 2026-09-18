import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/stripe";
import {
  GetFileLink,
  GetFiles,
  CreateFile,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const FILES_API_BASE_URL = "https://files.stripe.com";

/** 1×1 PNG — Stripe accepts PNG for `dispute_evidence`. */
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x01, 0x18, 0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

/** 2030-03-17 — Stripe rejects expiries more than five years out. */
const EXPIRES_AT = 1_900_000_000;
/** 2030-11-01 */
const EXPIRES_AT_UPDATED = 1_920_000_000;

const isMissing = isMissingStripeResource;

const waitUntilExpired = (id: string) =>
  GetFileLink({ link: id }).pipe(
    Effect.map((link) =>
      link.expired ? ("expired" as const) : ("active" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "expired" || status === "gone",
      times: 10,
    }),
  );

const FILE_PURPOSE = "dispute_evidence" as const;
const FILE_NAME = "alchemy-filelink.png";

const postFile = (file: File) =>
  Effect.gen(function* () {
    const resolve = yield* Credentials;
    const creds = yield* resolve;
    return yield* CreateFile({
      file: file as unknown as string,
      purpose: FILE_PURPOSE,
    }).pipe(
      Effect.provideService(
        Credentials,
        Effect.succeed({
          apiKey: creds.apiKey,
          apiBaseUrl: FILES_API_BASE_URL,
        }),
      ),
    );
  });

/**
 * Files cannot be deleted. Reuse a prior Alchemy-uploaded PNG when present;
 * otherwise upload a 1×1 PNG via distilled. Do not reuse arbitrary account
 * files — Stripe-generated files often reject `file_links` creates.
 */
const ensureFile = Effect.gen(function* () {
  const listed = yield* GetFiles({
    purpose: FILE_PURPOSE,
    limit: 100,
  });
  const existing = listed.data.find((file) => file.filename === FILE_NAME);
  if (existing !== undefined) return existing;
  const png = yield* Effect.sync(
    () => new File([PNG_1X1], FILE_NAME, { type: "image/png" }),
  );
  return yield* postFile(png);
});

test.provider(
  "file upload probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* ensureFile.pipe(Effect.result);
      if (Result.isSuccess(result)) {
        expect(result.success.id).toMatch(/^file_/);
      } else {
        expect([
          "InvalidRequestError",
          "Forbidden",
          "Unauthorized",
          "BadRequest",
        ]).toContain(result.failure._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider(
  "create, update, and expire a file link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const file = yield* ensureFile;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.FileLink("ReportLink", {
            file: file.id,
            metadata: { kind: "report" },
          });
        }),
      );

      expect(created.id).toMatch(/^link_/);
      expect(created.file).toEqual(file.id);
      expect(created.expired).toEqual(false);
      expect(created.expiresAt).toBeUndefined();
      expect(created.url).toEqual(expect.any(String));
      expect(created.metadata).toMatchObject({ kind: "report" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetFileLink({ link: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(
        typeof fetched.file === "string" ? fetched.file : fetched.file.id,
      ).toEqual(file.id);
      expect(fetched.expired).toEqual(false);
      expect(fetched.metadata?.kind).toEqual("report");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.FileLink("ReportLink", {
            file: file.id,
            expiresAt: EXPIRES_AT,
            metadata: { kind: "report", env: "test" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.file).toEqual(file.id);
      expect(updated.expired).toEqual(false);
      expect(updated.expiresAt).toEqual(EXPIRES_AT);
      expect(updated.metadata).toEqual({ kind: "report", env: "test" });

      const refetched = yield* GetFileLink({ link: updated.id });
      expect(refetched.expires_at).toEqual(EXPIRES_AT);
      expect(refetched.metadata?.kind).toEqual("report");
      expect(refetched.metadata?.env).toEqual("test");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const extended = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.FileLink("ReportLink", {
            file: file.id,
            expiresAt: EXPIRES_AT_UPDATED,
            metadata: { kind: "invoice" },
          });
        }),
      );

      expect(extended.id).toEqual(created.id);
      expect(extended.expiresAt).toEqual(EXPIRES_AT_UPDATED);
      expect(extended.metadata).toEqual({ kind: "invoice" });

      yield* stack.destroy();

      const expired = yield* waitUntilExpired(created.id);
      expect(expired).toEqual("expired");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed file link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const file = yield* ensureFile;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.FileLink("ListLink", {
            file: file.id,
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.FileLink);
      const all = yield* provider.list();
      const found = all.find((link) => link.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.file).toEqual(file.id);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const expired = yield* waitUntilExpired(deployed.id);
      expect(expired).toEqual("expired");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
