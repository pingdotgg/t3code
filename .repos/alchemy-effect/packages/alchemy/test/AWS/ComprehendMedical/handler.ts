import * as ComprehendMedical from "@/AWS/ComprehendMedical";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed (1-32 chars of [a-zA-Z0-9-]) but nonexistent job id — describe
// and stop must answer with the typed ResourceNotFoundException.
const FAKE_JOB_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export class ComprehendMedicalTestFunction extends Lambda.Function<Lambda.Function>()(
  "ComprehendMedicalTestFunction",
) {}

export default ComprehendMedicalTestFunction.make(
  {
    main,
    url: true,
    // Comprehend Medical inference can exceed Lambda's 3s default under load.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const detectEntities = yield* ComprehendMedical.DetectEntitiesV2();
    const detectPHI = yield* ComprehendMedical.DetectPHI();
    const inferICD10CM = yield* ComprehendMedical.InferICD10CM();
    const inferRxNorm = yield* ComprehendMedical.InferRxNorm();
    const inferSNOMEDCT = yield* ComprehendMedical.InferSNOMEDCT();

    const listEntitiesJobs =
      yield* ComprehendMedical.ListEntitiesDetectionV2Jobs();
    const listICD10CMJobs = yield* ComprehendMedical.ListICD10CMInferenceJobs();
    const listPHIJobs = yield* ComprehendMedical.ListPHIDetectionJobs();
    const listRxNormJobs = yield* ComprehendMedical.ListRxNormInferenceJobs();
    const listSNOMEDCTJobs =
      yield* ComprehendMedical.ListSNOMEDCTInferenceJobs();

    const describeEntitiesJob =
      yield* ComprehendMedical.DescribeEntitiesDetectionV2Job();
    const describeICD10CMJob =
      yield* ComprehendMedical.DescribeICD10CMInferenceJob();
    const describePHIJob = yield* ComprehendMedical.DescribePHIDetectionJob();
    const describeRxNormJob =
      yield* ComprehendMedical.DescribeRxNormInferenceJob();
    const describeSNOMEDCTJob =
      yield* ComprehendMedical.DescribeSNOMEDCTInferenceJob();

    const stopEntitiesJob =
      yield* ComprehendMedical.StopEntitiesDetectionV2Job();
    const stopICD10CMJob = yield* ComprehendMedical.StopICD10CMInferenceJob();
    const stopPHIJob = yield* ComprehendMedical.StopPHIDetectionJob();
    const stopRxNormJob = yield* ComprehendMedical.StopRxNormInferenceJob();
    const stopSNOMEDCTJob = yield* ComprehendMedical.StopSNOMEDCTInferenceJob();

    const startEntitiesJob =
      yield* ComprehendMedical.StartEntitiesDetectionV2Job();
    const startICD10CMJob = yield* ComprehendMedical.StartICD10CMInferenceJob();
    const startPHIJob = yield* ComprehendMedical.StartPHIDetectionJob();
    const startRxNormJob = yield* ComprehendMedical.StartRxNormInferenceJob();
    const startSNOMEDCTJob =
      yield* ComprehendMedical.StartSNOMEDCTInferenceJob();
    // The remaining start bindings attach their IAM statements at deploy
    // time; the PHI start callable is the one exercised at runtime.
    void startEntitiesJob;
    void startICD10CMJob;
    void startRxNormJob;
    void startSNOMEDCTJob;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Comprehend Medical call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/entities") {
          const result = yield* detectEntities({
            Text: "Patient takes 50 mg atenolol daily for hypertension.",
          });
          return yield* HttpServerResponse.json({
            entities: (result.Entities ?? []).map((entity) => ({
              text: entity.Text,
              category: entity.Category,
              type: entity.Type,
            })),
            modelVersion: result.ModelVersion,
          });
        }

        if (request.method === "GET" && pathname === "/phi") {
          const result = yield* detectPHI({
            Text: "John Doe, age 47, was seen on 2024-01-03 at Seattle Clinic.",
          });
          return yield* HttpServerResponse.json({
            entities: (result.Entities ?? []).map((entity) => ({
              text: entity.Text,
              type: entity.Type,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/icd10") {
          const result = yield* inferICD10CM({
            Text: "Patient presents with type 2 diabetes and hypertension.",
          });
          return yield* HttpServerResponse.json({
            entities: (result.Entities ?? []).map((entity) => ({
              text: entity.Text,
              codes: (entity.ICD10CMConcepts ?? []).map((concept) => ({
                code: concept.Code,
                description: concept.Description,
              })),
            })),
          });
        }

        if (request.method === "GET" && pathname === "/rxnorm") {
          const result = yield* inferRxNorm({
            Text: "Patient takes 50 mg atenolol daily and 500 mg metformin twice a day.",
          });
          return yield* HttpServerResponse.json({
            entities: (result.Entities ?? []).map((entity) => ({
              text: entity.Text,
              concepts: (entity.RxNormConcepts ?? []).map((concept) => ({
                code: concept.Code,
                description: concept.Description,
              })),
            })),
          });
        }

        if (request.method === "GET" && pathname === "/snomed") {
          const result = yield* inferSNOMEDCT({
            Text: "Patient presents with type 2 diabetes and hypertension.",
          });
          return yield* HttpServerResponse.json({
            entities: (result.Entities ?? []).map((entity) => ({
              text: entity.Text,
              concepts: (entity.SNOMEDCTConcepts ?? []).map((concept) => ({
                code: concept.Code,
                description: concept.Description,
              })),
            })),
          });
        }

        // Exercises the five List* bindings — real calls, no side effects.
        if (request.method === "GET" && pathname === "/jobs") {
          const [entities, icd10cm, phi, rxnorm, snomedct] = yield* Effect.all(
            [
              listEntitiesJobs({}),
              listICD10CMJobs({}),
              listPHIJobs({}),
              listRxNormJobs({}),
              listSNOMEDCTJobs({}),
            ],
            { concurrency: 5 },
          );
          return yield* HttpServerResponse.json({
            entities:
              entities.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0,
            icd10cm:
              icd10cm.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0,
            phi: phi.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0,
            rxnorm: rxnorm.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0,
            snomedct:
              snomedct.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0,
          });
        }

        // Exercises the Describe*/Stop* bindings against a nonexistent job:
        // IAM authorizes first, so the typed ResourceNotFoundException proves
        // both the wiring and the granted action.
        if (request.method === "GET" && pathname === "/job-checks") {
          const success = () => "Success" as string;
          const tagOf = (e: { readonly _tag: string }) =>
            Effect.succeed(e._tag as string);

          const [describes, stops] = yield* Effect.all([
            Effect.all(
              [
                describeEntitiesJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
                describeICD10CMJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
                describePHIJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
                describeRxNormJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
                describeSNOMEDCTJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
              ],
              { concurrency: 5 },
            ),
            Effect.all(
              [
                stopEntitiesJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
                stopICD10CMJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
                stopPHIJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
                stopRxNormJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
                stopSNOMEDCTJob({ JobId: FAKE_JOB_ID }).pipe(
                  Effect.map(success),
                  Effect.catchTag("ResourceNotFoundException", tagOf),
                ),
              ],
              { concurrency: 5 },
            ),
          ]);
          return yield* HttpServerResponse.json({ describes, stops });
        }

        // Exercises a Start* binding: the request passes the
        // comprehendmedical:StartPHIDetectionJob IAM check and fails typed on
        // the same-account-but-nonexistent data-access role supplied by the
        // test (DATA_ACCESS_ROLE_ARN_INVALID). An unauthorized caller would
        // get AccessDeniedException instead — so InvalidRequestException
        // proves the binding granted the Start action.
        if (request.method === "GET" && pathname === "/job-start") {
          const roleArn = url.searchParams.get("roleArn");
          if (!roleArn) {
            return yield* HttpServerResponse.json(
              { error: "roleArn query parameter required" },
              { status: 400 },
            );
          }
          const outcome = yield* startPHIJob({
            InputDataConfig: {
              S3Bucket: "alchemy-nonexistent-input-bucket",
              S3Key: "notes/",
            },
            OutputDataConfig: {
              S3Bucket: "alchemy-nonexistent-output-bucket",
            },
            DataAccessRoleArn: roleArn,
            LanguageCode: "en",
          }).pipe(
            Effect.map(() => ({ tag: "Success" })),
            Effect.catchTag(
              [
                "AccessDeniedException",
                "InvalidRequestException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed({ tag: e._tag as string }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ComprehendMedical.DetectEntitiesV2Http,
        ComprehendMedical.DetectPHIHttp,
        ComprehendMedical.InferICD10CMHttp,
        ComprehendMedical.InferRxNormHttp,
        ComprehendMedical.InferSNOMEDCTHttp,
        ComprehendMedical.ListEntitiesDetectionV2JobsHttp,
        ComprehendMedical.ListICD10CMInferenceJobsHttp,
        ComprehendMedical.ListPHIDetectionJobsHttp,
        ComprehendMedical.ListRxNormInferenceJobsHttp,
        ComprehendMedical.ListSNOMEDCTInferenceJobsHttp,
        ComprehendMedical.DescribeEntitiesDetectionV2JobHttp,
        ComprehendMedical.DescribeICD10CMInferenceJobHttp,
        ComprehendMedical.DescribePHIDetectionJobHttp,
        ComprehendMedical.DescribeRxNormInferenceJobHttp,
        ComprehendMedical.DescribeSNOMEDCTInferenceJobHttp,
        ComprehendMedical.StopEntitiesDetectionV2JobHttp,
        ComprehendMedical.StopICD10CMInferenceJobHttp,
        ComprehendMedical.StopPHIDetectionJobHttp,
        ComprehendMedical.StopRxNormInferenceJobHttp,
        ComprehendMedical.StopSNOMEDCTInferenceJobHttp,
        ComprehendMedical.StartEntitiesDetectionV2JobHttp,
        ComprehendMedical.StartICD10CMInferenceJobHttp,
        ComprehendMedical.StartPHIDetectionJobHttp,
        ComprehendMedical.StartRxNormInferenceJobHttp,
        ComprehendMedical.StartSNOMEDCTInferenceJobHttp,
      ),
    ),
  ),
);
