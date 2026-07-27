import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as glacier from "@distilled.cloud/aws/glacier";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import GlacierBindingsFunctionLive, {
  GlacierBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// The vault-based S3 Glacier API rejects accounts created after its 2025
// closure to new customers with the typed NoLongerSupportedException (see
// the ungated probes below and in Vault.test.ts). The live Lambda E2E needs
// a real vault, so it is gated behind AWS_TEST_GLACIER=1 for entitled
// (grandfathered) accounts.
const RUN_LIVE = !!process.env.AWS_TEST_GLACIER;

// Ungated typed-error probes: prove the distilled error unions the bindings
// depend on are typed on every account, entitled or not, at near-zero cost.
test.provider("listJobs on a nonexistent vault fails with a typed tag", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      glacier.listJobs({
        accountId: "-",
        vaultName: "alchemy-nonexistent-glacier-vault-probe",
      }),
    );
    expect([
      "ResourceNotFoundException",
      "NoLongerSupportedException",
    ]).toContain(error._tag);
  }),
);

test.provider(
  "uploadArchive on a nonexistent vault fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        glacier.uploadArchive({
          accountId: "-",
          vaultName: "alchemy-nonexistent-glacier-vault-probe",
          body: "alchemy-glacier-probe",
        }),
      );
      expect([
        "ResourceNotFoundException",
        "NoLongerSupportedException",
        "MissingParameterValueException",
        "InvalidParameterValueException",
      ]).toContain(error._tag);
    }),
);

const sharedStack = Core.scratchStack(testOptions, "GlacierBindings");

let baseUrl: string;

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const post = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe("Glacier Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("Glacier E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Glacier E2E setup: deploying vault + Lambda");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GlacierBindingsFunction;
        }).pipe(Effect.provide(GlacierBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "all 13 capabilities initialize in the runtime",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/bindings")) as any;
        expect(response.bound).toHaveLength(13);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "DescribeVault reads the bound vault's stats",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/vault")) as any;
        expect(typeof response.vaultName).toBe("string");
        expect(response.numberOfArchives).toBe(0);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "ListJobs + ListMultipartUploads round-trip against the empty vault",
    () =>
      Effect.gen(function* () {
        const jobs = (yield* get("/jobs")) as any;
        expect(jobs.count).toBe(0);
        const uploads = (yield* get("/uploads")) as any;
        expect(uploads.count).toBe(0);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "DescribeJob, GetJobOutput, and ListParts surface the typed not-found",
    () =>
      Effect.gen(function* () {
        const job = (yield* get("/jobs/typed-not-found")) as any;
        expect(job.typed).toBe(true);
        const output = (yield* get("/job-output/typed-not-found")) as any;
        expect(output.typed).toBe(true);
        const parts = (yield* get("/parts/typed-not-found")) as any;
        expect(parts.typed).toBe(true);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "multipart mutation bindings surface the typed not-found",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/multipart/typed-not-found")) as any;
        expect(response.upload).toBe(true);
        expect(response.complete).toBe(true);
        expect(response.abort).toBe(true);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "DeleteArchive and UploadArchive round-trip typed rejections",
    () =>
      Effect.gen(function* () {
        const deleted = (yield* post("/archive/typed-not-found")) as any;
        expect(deleted.typed).toBe(true);
        // Wrong checksum — rejected before storing, vault stays deletable.
        const uploaded = (yield* post("/archive/probe")) as any;
        expect(uploaded.typed).toBe(true);
        const multipart = (yield* post("/multipart/probe")) as any;
        expect(multipart.typed).toBe(true);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "InitiateJob starts (or typed-rejects) an inventory retrieval",
    () =>
      Effect.gen(function* () {
        const response = (yield* post("/jobs/inventory")) as any;
        // A fresh vault has no inventory yet — either the job starts or the
        // typed 400 comes back; both prove the grant end-to-end.
        if (response.started) {
          expect(typeof response.jobId).toBe("string");
        } else {
          expect([
            "InvalidParameterValueException",
            "ResourceNotFoundException",
          ]).toContain(response.error);
        }
      }),
  );
});
