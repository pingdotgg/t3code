import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ComprehendMedicalTestFunctionLive, {
  ComprehendMedicalTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ComprehendMedicalBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init, IAM propagation, throttling surfaced as a
// defect). Retry 5xx only; a genuine 4xx/assertion failure surfaces
// immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
      ]),
    }),
  );

describe("ComprehendMedical Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ComprehendMedical test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ComprehendMedical test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ComprehendMedicalTestFunction;
        }).pipe(Effect.provide(ComprehendMedicalTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `ComprehendMedical test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ComprehendMedical test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("DetectEntitiesV2", () => {
    test.provider(
      "extracts medical entities from a clinical note",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/entities`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            entities: Array<{ text: string; category: string; type: string }>;
            modelVersion: string;
          };

          expect(response.entities.length).toBeGreaterThan(0);
          // atenolol is a medication; hypertension is a medical condition.
          const categories = response.entities.map((e) => e.category);
          expect(categories).toContain("MEDICATION");
          expect(categories).toContain("MEDICAL_CONDITION");
          expect(response.modelVersion.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("DetectPHI", () => {
    test.provider(
      "detects protected health information",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/phi`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            entities: Array<{ text: string; type: string }>;
          };

          expect(response.entities.length).toBeGreaterThan(0);
          const types = response.entities.map((e) => e.type);
          // The note contains a name, an age, and a date.
          expect(types).toContain("NAME");
        }),
      { timeout: 120_000 },
    );
  });

  describe("InferICD10CM", () => {
    test.provider(
      "links conditions to ICD-10-CM codes",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/icd10`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            entities: Array<{
              text: string;
              codes: Array<{ code: string; description: string }>;
            }>;
          };

          expect(response.entities.length).toBeGreaterThan(0);
          const withCodes = response.entities.filter((e) => e.codes.length > 0);
          expect(withCodes.length).toBeGreaterThan(0);
          // ICD-10-CM codes look like "E11.9", "I10", etc.
          expect(withCodes[0].codes[0].code.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("InferRxNorm", () => {
    test.provider(
      "links medications to RxNorm concepts",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/rxnorm`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            entities: Array<{
              text: string;
              concepts: Array<{ code: string; description: string }>;
            }>;
          };

          expect(response.entities.length).toBeGreaterThan(0);
          const withConcepts = response.entities.filter(
            (e) => e.concepts.length > 0,
          );
          expect(withConcepts.length).toBeGreaterThan(0);
          expect(withConcepts[0].concepts[0].code.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("InferSNOMEDCT", () => {
    test.provider(
      "links concepts to SNOMED CT codes",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/snomed`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            entities: Array<{
              text: string;
              concepts: Array<{ code: string; description: string }>;
            }>;
          };

          expect(response.entities.length).toBeGreaterThan(0);
          const withConcepts = response.entities.filter(
            (e) => e.concepts.length > 0,
          );
          expect(withConcepts.length).toBeGreaterThan(0);
          expect(withConcepts[0].concepts[0].code.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("List*Jobs", () => {
    test.provider(
      "lists batch jobs across all five job families",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/jobs`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            entities: number;
            icd10cm: number;
            phi: number;
            rxnorm: number;
            snomedct: number;
          };

          // Every list call authorized and answered — counts are >= 0.
          expect(response.entities).toBeGreaterThanOrEqual(0);
          expect(response.icd10cm).toBeGreaterThanOrEqual(0);
          expect(response.phi).toBeGreaterThanOrEqual(0);
          expect(response.rxnorm).toBeGreaterThanOrEqual(0);
          expect(response.snomedct).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Describe*/Stop*Job", () => {
    test.provider(
      "answers with the typed ResourceNotFoundException for unknown jobs",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/job-checks`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            describes: string[];
            stops: string[];
          };

          // IAM authorizes before the job lookup, so the typed
          // ResourceNotFoundException proves both wiring and permissions
          // for every describe/stop binding.
          expect(response.describes).toEqual(
            Array(5).fill("ResourceNotFoundException"),
          );
          expect(response.stops).toEqual(
            Array(5).fill("ResourceNotFoundException"),
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("StartPHIDetectionJob", () => {
    test.provider(
      "passes IAM authorization and fails typed on the bogus data-access role",
      (_stack) =>
        Effect.gen(function* () {
          // A same-account-but-nonexistent role is rejected AFTER the
          // comprehendmedical:StartPHIDetectionJob authorization with the
          // typed InvalidRequestException (DATA_ACCESS_ROLE_ARN_INVALID); a
          // caller missing the Start permission gets AccessDeniedException
          // instead — so this proves the binding granted the action.
          const { Account } = yield* sts.getCallerIdentity({});
          const roleArn = `arn:aws:iam::${Account}:role/alchemy-nonexistent-comprehendmedical-role`;

          const response = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/job-start?roleArn=${encodeURIComponent(roleArn)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as { tag: string };

          expect(response.tag).toBe("InvalidRequestException");
        }),
      { timeout: 120_000 },
    );
  });
});
