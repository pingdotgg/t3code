import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Transcribe from "@/AWS/Transcribe";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// An S3 URI that fails Transcribe's server-side pattern validation — drives
// every Start*/Create* binding through its typed BadRequestException path
// without actually starting (and paying for) a job or leaving anything
// behind to clean up.
const INVALID_S3_URI = "invalid-uri";

export class TranscribeTestFunction extends Lambda.Function<Lambda.Function>()(
  "TranscribeTestFunction",
) {}

export default TranscribeTestFunction.make(
  {
    main,
    url: true,
    // Transcribe control-plane calls routinely take a couple of seconds;
    // AWS's default 3s Lambda timeout is too tight under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The role Amazon Transcribe assumes to read S3 media for the role-bound
    // bindings (StartCallAnalyticsJob, StartMedicalScribeJob,
    // CreateLanguageModel). Requests here never get past validation, so the
    // role needs no real S3 grants — only the transcribe.amazonaws.com trust.
    const dataAccessRole = yield* IAM.Role("TranscribeDataAccessRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "transcribe.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });

    // --- batch transcription jobs ---
    const startJob = yield* Transcribe.StartTranscriptionJob();
    const getJob = yield* Transcribe.GetTranscriptionJob();
    const listJobs = yield* Transcribe.ListTranscriptionJobs();
    const deleteJob = yield* Transcribe.DeleteTranscriptionJob();

    // --- call analytics jobs ---
    const startCallJob =
      yield* Transcribe.StartCallAnalyticsJob(dataAccessRole);
    const getCallJob = yield* Transcribe.GetCallAnalyticsJob();
    const listCallJobs = yield* Transcribe.ListCallAnalyticsJobs();
    const deleteCallJob = yield* Transcribe.DeleteCallAnalyticsJob();

    // --- medical transcription jobs ---
    const startMedicalJob = yield* Transcribe.StartMedicalTranscriptionJob();
    const getMedicalJob = yield* Transcribe.GetMedicalTranscriptionJob();
    const listMedicalJobs = yield* Transcribe.ListMedicalTranscriptionJobs();
    const deleteMedicalJob = yield* Transcribe.DeleteMedicalTranscriptionJob();

    // --- medical scribe jobs ---
    const startScribeJob =
      yield* Transcribe.StartMedicalScribeJob(dataAccessRole);
    const getScribeJob = yield* Transcribe.GetMedicalScribeJob();
    const listScribeJobs = yield* Transcribe.ListMedicalScribeJobs();
    const deleteScribeJob = yield* Transcribe.DeleteMedicalScribeJob();

    // --- custom vocabularies ---
    const createVocabulary = yield* Transcribe.CreateVocabulary();
    const getVocabulary = yield* Transcribe.GetVocabulary();
    const updateVocabulary = yield* Transcribe.UpdateVocabulary();
    const deleteVocabulary = yield* Transcribe.DeleteVocabulary();
    const listVocabularies = yield* Transcribe.ListVocabularies();

    // --- vocabulary filters ---
    const createFilter = yield* Transcribe.CreateVocabularyFilter();
    const getFilter = yield* Transcribe.GetVocabularyFilter();
    const updateFilter = yield* Transcribe.UpdateVocabularyFilter();
    const deleteFilter = yield* Transcribe.DeleteVocabularyFilter();
    const listFilters = yield* Transcribe.ListVocabularyFilters();

    // --- medical vocabularies ---
    const createMedicalVocabulary = yield* Transcribe.CreateMedicalVocabulary();
    const getMedicalVocabulary = yield* Transcribe.GetMedicalVocabulary();
    const updateMedicalVocabulary = yield* Transcribe.UpdateMedicalVocabulary();
    const deleteMedicalVocabulary = yield* Transcribe.DeleteMedicalVocabulary();
    const listMedicalVocabularies = yield* Transcribe.ListMedicalVocabularies();

    // --- call analytics categories ---
    const createCategory = yield* Transcribe.CreateCallAnalyticsCategory();
    const getCategory = yield* Transcribe.GetCallAnalyticsCategory();
    const updateCategory = yield* Transcribe.UpdateCallAnalyticsCategory();
    const deleteCategory = yield* Transcribe.DeleteCallAnalyticsCategory();
    const listCategories = yield* Transcribe.ListCallAnalyticsCategories();

    // --- custom language models ---
    const createLanguageModel =
      yield* Transcribe.CreateLanguageModel(dataAccessRole);
    const describeLanguageModel = yield* Transcribe.DescribeLanguageModel();
    const listLanguageModels = yield* Transcribe.ListLanguageModels();
    const deleteLanguageModel = yield* Transcribe.DeleteLanguageModel();

    // --- tagging ---
    const tagResource = yield* Transcribe.TagResource();
    const untagResource = yield* Transcribe.UntagResource();
    const listTagsForResource = yield* Transcribe.ListTagsForResource();

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.transcribe) targeting this Function. The test verifies the rule
    // deploys; runtime firing would require a real transcription over S3
    // media.
    yield* Transcribe.consumeTranscriptionJobEvents(
      { statuses: ["COMPLETED", "FAILED"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `transcribe job event: ${event.detail.TranscriptionJobName} -> ${event.detail.TranscriptionJobStatus}`,
          ),
        ),
    );

    // Normalize every binding call to { ok, error?, ...extra } so routes can
    // assert typed tags without 500s.
    const result = <A, E extends { _tag: string }>(
      effect: Effect.Effect<A, E>,
      extract?: (a: A) => Record<string, unknown>,
    ) =>
      effect.pipe(
        Effect.map((a) => ({
          ok: true,
          error: undefined as string | undefined,
          ...(extract ? extract(a) : {}),
        })),
        Effect.catch((e) =>
          Effect.succeed({ ok: false, error: e._tag as string }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const route = `${request.method} ${url.pathname}`;
        const name = url.searchParams.get("name") ?? "";
        const body =
          request.method === "POST"
            ? ((yield* request.json) as Record<string, string>)
            : {};

        const respond = (
          effect: Effect.Effect<Record<string, unknown>, never>,
        ) => effect.pipe(Effect.flatMap(HttpServerResponse.json));

        switch (route) {
          // --- lists (count proves grant + wire-up) ---
          case "GET /jobs":
            return yield* respond(
              result(listJobs({ MaxResults: 5 }), (r) => ({
                count: r.TranscriptionJobSummaries?.length ?? 0,
              })),
            );
          case "GET /callJobs":
            return yield* respond(
              result(listCallJobs({ MaxResults: 5 }), (r) => ({
                count: r.CallAnalyticsJobSummaries?.length ?? 0,
              })),
            );
          case "GET /medicalJobs":
            return yield* respond(
              result(listMedicalJobs({ MaxResults: 5 }), (r) => ({
                count: r.MedicalTranscriptionJobSummaries?.length ?? 0,
              })),
            );
          case "GET /scribeJobs":
            return yield* respond(
              result(listScribeJobs({ MaxResults: 5 }), (r) => ({
                count: r.MedicalScribeJobSummaries?.length ?? 0,
              })),
            );
          case "GET /vocabularies":
            return yield* respond(
              result(listVocabularies({ MaxResults: 5 }), (r) => ({
                count: r.Vocabularies?.length ?? 0,
              })),
            );
          case "GET /medicalVocabularies":
            return yield* respond(
              result(listMedicalVocabularies({ MaxResults: 5 }), (r) => ({
                count: r.Vocabularies?.length ?? 0,
              })),
            );
          case "GET /filters":
            return yield* respond(
              result(listFilters({ MaxResults: 5 }), (r) => ({
                count: r.VocabularyFilters?.length ?? 0,
              })),
            );
          case "GET /categories":
            return yield* respond(
              result(listCategories({ MaxResults: 5 }), (r) => ({
                count: r.Categories?.length ?? 0,
              })),
            );
          case "GET /languageModels":
            return yield* respond(
              result(listLanguageModels({ MaxResults: 5 }), (r) => ({
                count: r.Models?.length ?? 0,
              })),
            );

          // --- reads (typed not-found tags for bogus names) ---
          case "GET /job":
            return yield* respond(
              result(getJob({ TranscriptionJobName: name }), (r) => ({
                status: r.TranscriptionJob?.TranscriptionJobStatus,
              })),
            );
          case "GET /callJob":
            return yield* respond(
              result(getCallJob({ CallAnalyticsJobName: name }), (r) => ({
                status: r.CallAnalyticsJob?.CallAnalyticsJobStatus,
              })),
            );
          case "GET /medicalJob":
            return yield* respond(
              result(
                getMedicalJob({ MedicalTranscriptionJobName: name }),
                (r) => ({
                  status: r.MedicalTranscriptionJob?.TranscriptionJobStatus,
                }),
              ),
            );
          case "GET /scribeJob":
            return yield* respond(
              result(getScribeJob({ MedicalScribeJobName: name }), (r) => ({
                status: r.MedicalScribeJob?.MedicalScribeJobStatus,
              })),
            );
          case "GET /vocabulary":
            return yield* respond(
              result(getVocabulary({ VocabularyName: name }), (r) => ({
                state: r.VocabularyState,
              })),
            );
          case "GET /medicalVocabulary":
            return yield* respond(
              result(getMedicalVocabulary({ VocabularyName: name }), (r) => ({
                state: r.VocabularyState,
              })),
            );
          case "GET /languageModel":
            return yield* respond(
              result(describeLanguageModel({ ModelName: name }), (r) => ({
                status: r.LanguageModel?.ModelStatus,
              })),
            );

          // --- deletes (typed tags for bogus names; real delete for fixtures) ---
          case "POST /job/delete":
            return yield* respond(
              result(deleteJob({ TranscriptionJobName: body.name! })),
            );
          case "POST /callJob/delete":
            return yield* respond(
              result(deleteCallJob({ CallAnalyticsJobName: body.name! })),
            );
          case "POST /medicalJob/delete":
            return yield* respond(
              result(
                deleteMedicalJob({ MedicalTranscriptionJobName: body.name! }),
              ),
            );
          case "POST /scribeJob/delete":
            return yield* respond(
              result(deleteScribeJob({ MedicalScribeJobName: body.name! })),
            );
          case "POST /vocabulary/delete":
            return yield* respond(
              result(deleteVocabulary({ VocabularyName: body.name! })),
            );
          case "POST /medicalVocabulary/delete":
            return yield* respond(
              result(deleteMedicalVocabulary({ VocabularyName: body.name! })),
            );
          case "POST /languageModel/delete":
            return yield* respond(
              result(deleteLanguageModel({ ModelName: body.name! })),
            );

          // --- starts/creates driven through typed validation failures
          //     (invalid S3 URI: nothing is created, nothing is billed) ---
          case "POST /startJob":
            return yield* respond(
              result(
                startJob({
                  TranscriptionJobName: body.name!,
                  LanguageCode: "en-US",
                  Media: { MediaFileUri: INVALID_S3_URI },
                }),
              ),
            );
          case "POST /startCall":
            return yield* respond(
              result(
                startCallJob({
                  CallAnalyticsJobName: body.name!,
                  Media: { MediaFileUri: INVALID_S3_URI },
                }),
              ),
            );
          case "POST /startMedical":
            return yield* respond(
              result(
                startMedicalJob({
                  MedicalTranscriptionJobName: body.name!,
                  LanguageCode: "en-US",
                  Media: { MediaFileUri: INVALID_S3_URI },
                  OutputBucketName: "alchemy-nonexistent-output",
                  Specialty: "PRIMARYCARE",
                  Type: "DICTATION",
                }),
              ),
            );
          case "POST /startScribe":
            return yield* respond(
              result(
                startScribeJob({
                  MedicalScribeJobName: body.name!,
                  Media: { MediaFileUri: INVALID_S3_URI },
                  OutputBucketName: "alchemy-nonexistent-output",
                  Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 2 },
                }),
              ),
            );
          case "POST /vocabulary/create":
            return yield* respond(
              result(
                createVocabulary({
                  VocabularyName: body.name!,
                  LanguageCode: "en-US",
                  VocabularyFileUri: INVALID_S3_URI,
                }),
              ),
            );
          case "POST /vocabulary/update":
            return yield* respond(
              result(
                updateVocabulary({
                  VocabularyName: body.name!,
                  LanguageCode: "en-US",
                  Phrases: ["alchemy"],
                }),
              ),
            );
          case "POST /medicalVocabulary/create":
            return yield* respond(
              result(
                createMedicalVocabulary({
                  VocabularyName: body.name!,
                  LanguageCode: "en-US",
                  VocabularyFileUri: INVALID_S3_URI,
                }),
              ),
            );
          case "POST /medicalVocabulary/update":
            return yield* respond(
              result(
                updateMedicalVocabulary({
                  VocabularyName: body.name!,
                  LanguageCode: "en-US",
                  VocabularyFileUri: INVALID_S3_URI,
                }),
              ),
            );
          case "POST /languageModel/create":
            return yield* respond(
              result(
                createLanguageModel({
                  ModelName: body.name!,
                  BaseModelName: "NarrowBand",
                  LanguageCode: "en-US",
                  InputDataConfig: { S3Uri: INVALID_S3_URI },
                }),
              ),
            );

          // --- vocabulary filter lifecycle (real create/get/update/delete) ---
          case "POST /filter/create":
            return yield* respond(
              result(
                createFilter({
                  VocabularyFilterName: body.name!,
                  LanguageCode: "en-US",
                  Words: ["alchemyzz", "distilledzz"],
                }),
                (r) => ({ name: r.VocabularyFilterName }),
              ),
            );
          case "GET /filter":
            return yield* respond(
              result(getFilter({ VocabularyFilterName: name }), (r) => ({
                name: r.VocabularyFilterName,
                downloadUri: r.DownloadUri,
              })),
            );
          case "POST /filter/update":
            return yield* respond(
              result(
                updateFilter({
                  VocabularyFilterName: body.name!,
                  Words: ["alchemyzz", "distilledzz", "workerdzz"],
                }),
              ),
            );
          case "POST /filter/delete":
            return yield* respond(
              result(deleteFilter({ VocabularyFilterName: body.name! })),
            );

          // --- call analytics category lifecycle ---
          case "POST /category/create":
            return yield* respond(
              result(
                createCategory({
                  CategoryName: body.name!,
                  Rules: [{ NonTalkTimeFilter: { Threshold: 30000 } }],
                }),
                (r) => ({ name: r.CategoryProperties?.CategoryName }),
              ),
            );
          case "GET /category":
            return yield* respond(
              result(getCategory({ CategoryName: name }), (r) => ({
                rules: r.CategoryProperties?.Rules?.length ?? 0,
              })),
            );
          case "POST /category/update":
            return yield* respond(
              result(
                updateCategory({
                  CategoryName: body.name!,
                  Rules: [{ NonTalkTimeFilter: { Threshold: 60000 } }],
                }),
                (r) => ({ rules: r.CategoryProperties?.Rules?.length ?? 0 }),
              ),
            );
          case "POST /category/delete":
            return yield* respond(
              result(deleteCategory({ CategoryName: body.name! })),
            );

          // --- tagging (ARN supplied by the test) ---
          case "POST /tag":
            return yield* respond(
              result(
                tagResource({
                  ResourceArn: body.arn!,
                  Tags: [{ Key: "alchemy-test", Value: "1" }],
                }),
              ),
            );
          case "GET /tags":
            return yield* respond(
              result(
                listTagsForResource({
                  ResourceArn: url.searchParams.get("arn") ?? "",
                }),
                (r) => ({ count: r.Tags?.length ?? 0 }),
              ),
            );
          case "POST /untag":
            return yield* respond(
              result(
                untagResource({
                  ResourceArn: body.arn!,
                  TagKeys: ["alchemy-test"],
                }),
              ),
            );

          default:
            return yield* HttpServerResponse.json(
              { error: "Not found", route },
              { status: 404 },
            );
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        Layer.mergeAll(
          Transcribe.StartTranscriptionJobHttp,
          Transcribe.GetTranscriptionJobHttp,
          Transcribe.ListTranscriptionJobsHttp,
          Transcribe.DeleteTranscriptionJobHttp,
          Transcribe.StartCallAnalyticsJobHttp,
          Transcribe.GetCallAnalyticsJobHttp,
          Transcribe.ListCallAnalyticsJobsHttp,
          Transcribe.DeleteCallAnalyticsJobHttp,
          Transcribe.StartMedicalTranscriptionJobHttp,
          Transcribe.GetMedicalTranscriptionJobHttp,
          Transcribe.ListMedicalTranscriptionJobsHttp,
          Transcribe.DeleteMedicalTranscriptionJobHttp,
          Transcribe.StartMedicalScribeJobHttp,
          Transcribe.GetMedicalScribeJobHttp,
          Transcribe.ListMedicalScribeJobsHttp,
          Transcribe.DeleteMedicalScribeJobHttp,
        ),
        Layer.mergeAll(
          Transcribe.CreateVocabularyHttp,
          Transcribe.GetVocabularyHttp,
          Transcribe.UpdateVocabularyHttp,
          Transcribe.DeleteVocabularyHttp,
          Transcribe.ListVocabulariesHttp,
          Transcribe.CreateVocabularyFilterHttp,
          Transcribe.GetVocabularyFilterHttp,
          Transcribe.UpdateVocabularyFilterHttp,
          Transcribe.DeleteVocabularyFilterHttp,
          Transcribe.ListVocabularyFiltersHttp,
          Transcribe.CreateMedicalVocabularyHttp,
          Transcribe.GetMedicalVocabularyHttp,
          Transcribe.UpdateMedicalVocabularyHttp,
          Transcribe.DeleteMedicalVocabularyHttp,
          Transcribe.ListMedicalVocabulariesHttp,
        ),
        Layer.mergeAll(
          Transcribe.CreateCallAnalyticsCategoryHttp,
          Transcribe.GetCallAnalyticsCategoryHttp,
          Transcribe.UpdateCallAnalyticsCategoryHttp,
          Transcribe.DeleteCallAnalyticsCategoryHttp,
          Transcribe.ListCallAnalyticsCategoriesHttp,
          Transcribe.CreateLanguageModelHttp,
          Transcribe.DescribeLanguageModelHttp,
          Transcribe.ListLanguageModelsHttp,
          Transcribe.DeleteLanguageModelHttp,
          Transcribe.TagResourceHttp,
          Transcribe.UntagResourceHttp,
          Transcribe.ListTagsForResourceHttp,
        ),
      ),
    ),
  ),
);
