import * as Lambda from "@/AWS/Lambda";
import * as Rekognition from "@/AWS/Rekognition";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic collection id — this suite owns it in the testing account and
// the lifecycle route deletes it on entry and exit, so reruns self-heal.
export const TEST_COLLECTION_ID = "alchemy-test-rekognition-bindings";

// A 100x100 RGB PNG (blue sky, green ground, yellow sun disc) generated once
// and checked in — big enough for Rekognition's 80px minimum dimension. It
// contains no faces, which the face routes exploit: IndexFaces succeeds with
// zero face records and SearchFacesByImage surfaces the typed
// InvalidParameterException ("no faces in image"), both proving IAM + call
// plumbing end-to-end.
const TEST_IMAGE_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAAABNElEQVR4nO3YUQ3CMABF0cpBBN/IQc5EoGkOcMAXCkjK2u6l60n6v+Tsvo5Qnq+3UylQSNULwII15m5RFixlxb9FZghLWWaYJ3BnwVJWnGC5GX72268Dq4qpO1lZQaqXV1lEqotXWUeq3assJdXoBevSWI1ZtcQFC5ayzNCd5YKPfwfNEJayLrPEw8+d70cprPO8Wl7SlGUd9mp84sRY/ikd5dXl3cxdVg1Zx6dcBOucAwuWsswwT+DOgqWsOIEZwlJWnMAMYSkrTmCGsJQVJzBDWMqKE5ghLGXNNMP79nAqBWD90QosWGPuFmXBUlb8q22GsJRlhnkCdxYsZcUJzBCWsuIEZghLWXECM4SlrDiBGcJSVpzADGEpK05ghrCUFScwQ1jKihOYISxlxQnMENYWLusLBGA4iOtydmQAAAAASUVORK5CYII=";
const imageBytes = Buffer.from(TEST_IMAGE_B64, "base64");

// Well-formed-but-nonexistent identifiers used to drive the typed not-found
// paths. An IAM gap would surface AccessDeniedException (a 500 through the
// handler's orDie), so a typed not-found/validation tag proves the grant
// end-to-end.
const BOGUS_JOB_ID = "0".repeat(64);
const BOGUS_FACE_ID = "00000000-0000-0000-0000-000000000000";
const BOGUS_SESSION_ID = "00000000-0000-0000-0000-000000000000";
const BOGUS_BUCKET = "alchemy-nonexistent-rekognition-test-bucket";
const BOGUS_VIDEO = {
  S3Object: { Bucket: BOGUS_BUCKET, Name: "video.mp4" },
};

export class RekognitionTestFunction extends Lambda.Function<Lambda.Function>()(
  "RekognitionTestFunction",
) {}

export default RekognitionTestFunction.make(
  {
    main,
    url: true,
    // The image-analysis route runs seven sequential inferences and the
    // collection route ~15 sequential data-plane calls.
    timeout: Duration.seconds(120),
    // The bundled Rekognition schema graph is large — the 128 MB default
    // leaves almost no headroom (observed Max Memory Used: 118 MB on the
    // cheap routes alone).
    memorySize: 512,
  },
  Effect.gen(function* () {
    // --- image analysis ---
    const compareFaces = yield* Rekognition.CompareFaces();
    const detectFaces = yield* Rekognition.DetectFaces();
    const detectLabels = yield* Rekognition.DetectLabels();
    const detectModerationLabels = yield* Rekognition.DetectModerationLabels();
    const detectProtectiveEquipment =
      yield* Rekognition.DetectProtectiveEquipment();
    const detectText = yield* Rekognition.DetectText();
    const recognizeCelebrities = yield* Rekognition.RecognizeCelebrities();
    const getCelebrityInfo = yield* Rekognition.GetCelebrityInfo();

    // --- face collections ---
    const createCollection = yield* Rekognition.CreateCollection();
    const deleteCollection = yield* Rekognition.DeleteCollection();
    const describeCollection = yield* Rekognition.DescribeCollection();
    const listCollections = yield* Rekognition.ListCollections();
    const indexFaces = yield* Rekognition.IndexFaces();
    const listFaces = yield* Rekognition.ListFaces();
    const deleteFaces = yield* Rekognition.DeleteFaces();
    const searchFaces = yield* Rekognition.SearchFaces();
    const searchFacesByImage = yield* Rekognition.SearchFacesByImage();

    // --- user search ---
    const createUser = yield* Rekognition.CreateUser();
    const deleteUser = yield* Rekognition.DeleteUser();
    const listUsers = yield* Rekognition.ListUsers();
    const associateFaces = yield* Rekognition.AssociateFaces();
    const disassociateFaces = yield* Rekognition.DisassociateFaces();
    const searchUsers = yield* Rekognition.SearchUsers();
    const searchUsersByImage = yield* Rekognition.SearchUsersByImage();

    // --- face liveness ---
    const createFaceLivenessSession =
      yield* Rekognition.CreateFaceLivenessSession();
    const getFaceLivenessSessionResults =
      yield* Rekognition.GetFaceLivenessSessionResults();

    // --- video analysis ---
    const startCelebrityRecognition =
      yield* Rekognition.StartCelebrityRecognition();
    const getCelebrityRecognition =
      yield* Rekognition.GetCelebrityRecognition();
    const startContentModeration = yield* Rekognition.StartContentModeration();
    const getContentModeration = yield* Rekognition.GetContentModeration();
    const startFaceDetection = yield* Rekognition.StartFaceDetection();
    const getFaceDetection = yield* Rekognition.GetFaceDetection();
    const startFaceSearch = yield* Rekognition.StartFaceSearch();
    const getFaceSearch = yield* Rekognition.GetFaceSearch();
    const startLabelDetection = yield* Rekognition.StartLabelDetection();
    const getLabelDetection = yield* Rekognition.GetLabelDetection();
    const startPersonTracking = yield* Rekognition.StartPersonTracking();
    const getPersonTracking = yield* Rekognition.GetPersonTracking();
    const startSegmentDetection = yield* Rekognition.StartSegmentDetection();
    const getSegmentDetection = yield* Rekognition.GetSegmentDetection();
    const startTextDetection = yield* Rekognition.StartTextDetection();
    const getTextDetection = yield* Rekognition.GetTextDetection();

    // --- media analysis jobs ---
    const startMediaAnalysisJob = yield* Rekognition.StartMediaAnalysisJob();
    const getMediaAnalysisJob = yield* Rekognition.GetMediaAnalysisJob();
    const listMediaAnalysisJobs = yield* Rekognition.ListMediaAnalysisJobs();

    // --- stream processors ---
    const startStreamProcessor = yield* Rekognition.StartStreamProcessor();
    const stopStreamProcessor = yield* Rekognition.StopStreamProcessor();
    const describeStreamProcessor =
      yield* Rekognition.DescribeStreamProcessor();
    const listStreamProcessors = yield* Rekognition.ListStreamProcessors();

    // --- custom labels ---
    const detectCustomLabels = yield* Rekognition.DetectCustomLabels();
    const describeProjects = yield* Rekognition.DescribeProjects();
    const describeProjectVersions =
      yield* Rekognition.DescribeProjectVersions();
    const startProjectVersion = yield* Rekognition.StartProjectVersion();
    const stopProjectVersion = yield* Rekognition.StopProjectVersion();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no Rekognition call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        // One route drives every synchronous image-analysis binding against
        // the embedded test image (real inferences; the image has no faces,
        // so CompareFaces surfaces its typed InvalidParameterException).
        if (request.method === "GET" && pathname === "/analyze-image") {
          const labels = yield* detectLabels({
            Image: { Bytes: imageBytes },
            MaxLabels: 10,
          });
          const faces = yield* detectFaces({ Image: { Bytes: imageBytes } });
          const moderation = yield* detectModerationLabels({
            Image: { Bytes: imageBytes },
          });
          const text = yield* detectText({ Image: { Bytes: imageBytes } });
          const ppe = yield* detectProtectiveEquipment({
            Image: { Bytes: imageBytes },
          });
          const celebrities = yield* recognizeCelebrities({
            Image: { Bytes: imageBytes },
          });
          const compareTag = yield* compareFaces({
            SourceImage: { Bytes: imageBytes },
            TargetImage: { Bytes: imageBytes },
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag("InvalidParameterException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const celebrityInfoTag = yield* getCelebrityInfo({
            Id: "0000000000",
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({
            labelNames: (labels.Labels ?? []).map((l) => l.Name),
            faceCount: (faces.FaceDetails ?? []).length,
            moderationCount: (moderation.ModerationLabels ?? []).length,
            textCount: (text.TextDetections ?? []).length,
            ppePersons: (ppe.Persons ?? []).length,
            celebrityCount: (celebrities.CelebrityFaces ?? []).length,
            compareTag,
            celebrityInfoTag,
          });
        }

        // Full real lifecycle of the collection + user data plane: create a
        // collection, describe/list it, index a (faceless) image, create and
        // list a user, drive the face-id ops through their typed not-found
        // paths, then tear everything down.
        if (request.method === "POST" && pathname === "/collections") {
          // Self-heal from a previous crashed run.
          yield* deleteCollection({ CollectionId: TEST_COLLECTION_ID }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          const created = yield* createCollection({
            CollectionId: TEST_COLLECTION_ID,
          }).pipe(
            Effect.map((r) => r.StatusCode ?? 200),
            Effect.catchTag("ResourceAlreadyExistsException", () =>
              Effect.succeed(200),
            ),
          );
          const described = yield* describeCollection({
            CollectionId: TEST_COLLECTION_ID,
          });
          const collections = yield* listCollections({ MaxResults: 100 });
          const indexed = yield* indexFaces({
            CollectionId: TEST_COLLECTION_ID,
            Image: { Bytes: imageBytes },
          });
          const faces = yield* listFaces({
            CollectionId: TEST_COLLECTION_ID,
          });
          yield* createUser({
            CollectionId: TEST_COLLECTION_ID,
            UserId: "test-user",
          }).pipe(Effect.catchTag("ConflictException", () => Effect.void));
          const users = yield* listUsers({
            CollectionId: TEST_COLLECTION_ID,
          });
          const searchUsersTag = yield* searchUsers({
            CollectionId: TEST_COLLECTION_ID,
            UserId: "test-user",
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag(
              ["InvalidParameterException", "ResourceNotFoundException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const associateTag = yield* associateFaces({
            CollectionId: TEST_COLLECTION_ID,
            UserId: "test-user",
            FaceIds: [BOGUS_FACE_ID],
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag(
              ["InvalidParameterException", "ResourceNotFoundException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const disassociateTag = yield* disassociateFaces({
            CollectionId: TEST_COLLECTION_ID,
            UserId: "test-user",
            FaceIds: [BOGUS_FACE_ID],
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag(
              ["InvalidParameterException", "ResourceNotFoundException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const searchFacesTag = yield* searchFaces({
            CollectionId: TEST_COLLECTION_ID,
            FaceId: BOGUS_FACE_ID,
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag(
              ["InvalidParameterException", "ResourceNotFoundException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const searchFacesByImageTag = yield* searchFacesByImage({
            CollectionId: TEST_COLLECTION_ID,
            Image: { Bytes: imageBytes },
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag("InvalidParameterException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const searchUsersByImageTag = yield* searchUsersByImage({
            CollectionId: TEST_COLLECTION_ID,
            Image: { Bytes: imageBytes },
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag("InvalidParameterException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const deleteFacesTag = yield* deleteFaces({
            CollectionId: TEST_COLLECTION_ID,
            FaceIds: [BOGUS_FACE_ID],
          }).pipe(
            Effect.map(() => "Success"),
            Effect.catchTag("InvalidParameterException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          yield* deleteUser({
            CollectionId: TEST_COLLECTION_ID,
            UserId: "test-user",
          }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          yield* deleteCollection({ CollectionId: TEST_COLLECTION_ID });
          return yield* HttpServerResponse.json({
            createStatus: created,
            faceCountAtCreate: described.FaceCount ?? 0,
            listedCollection: (collections.CollectionIds ?? []).includes(
              TEST_COLLECTION_ID,
            ),
            indexedFaceRecords: (indexed.FaceRecords ?? []).length,
            listedFaces: (faces.Faces ?? []).length,
            listedUsers: (users.Users ?? []).map((u) => u.UserId),
            searchUsersTag,
            associateTag,
            disassociateTag,
            searchFacesTag,
            searchFacesByImageTag,
            searchUsersByImageTag,
            deleteFacesTag,
          });
        }

        // Real Face Liveness lifecycle: create a session, read its CREATED
        // status back, and drive the typed SessionNotFoundException path.
        if (request.method === "POST" && pathname === "/liveness") {
          const session = yield* createFaceLivenessSession();
          const results = yield* getFaceLivenessSessionResults({
            SessionId: session.SessionId,
          });
          const notFoundTag = yield* getFaceLivenessSessionResults({
            SessionId: BOGUS_SESSION_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("SessionNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({
            sessionId: session.SessionId,
            status: results.Status,
            notFoundTag,
          });
        }

        // Drives all eight Start* video bindings through Rekognition's typed
        // server-side S3 validation (nonexistent bucket) — real runtime calls
        // proving IAM without paying for eight async video jobs.
        if (request.method === "POST" && pathname === "/video/start-all") {
          const tags = {
            celebrityRecognition: yield* startCelebrityRecognition({
              Video: BOGUS_VIDEO,
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            ),
            contentModeration: yield* startContentModeration({
              Video: BOGUS_VIDEO,
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            ),
            faceDetection: yield* startFaceDetection({
              Video: BOGUS_VIDEO,
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            ),
            // FaceSearch also validates the collection — it may surface
            // ResourceNotFoundException before the S3 check.
            faceSearch: yield* startFaceSearch({
              Video: BOGUS_VIDEO,
              CollectionId: "alchemy-nonexistent-collection",
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            ),
            labelDetection: yield* startLabelDetection({
              Video: BOGUS_VIDEO,
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            ),
            personTracking: yield* startPersonTracking({
              Video: BOGUS_VIDEO,
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            ),
            segmentDetection: yield* startSegmentDetection({
              Video: BOGUS_VIDEO,
              SegmentTypes: ["SHOT"],
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            ),
            textDetection: yield* startTextDetection({
              Video: BOGUS_VIDEO,
            }).pipe(
              Effect.map(() => "Started"),
              Effect.catch((e) => Effect.succeed(e._tag)),
            ),
          };
          return yield* HttpServerResponse.json(tags);
        }

        // Drives all eight Get* video bindings through their typed
        // ResourceNotFoundException path with a well-formed bogus JobId.
        if (request.method === "GET" && pathname === "/video/get-all") {
          const probe = { JobId: BOGUS_JOB_ID };
          const tags = {
            celebrityRecognition: yield* getCelebrityRecognition(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                [
                  "ResourceNotFoundException",
                  "InvalidParameterException",
                  "AccessDeniedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            contentModeration: yield* getContentModeration(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                [
                  "ResourceNotFoundException",
                  "InvalidParameterException",
                  "AccessDeniedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            faceDetection: yield* getFaceDetection(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                [
                  "ResourceNotFoundException",
                  "InvalidParameterException",
                  "AccessDeniedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            faceSearch: yield* getFaceSearch(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                [
                  "ResourceNotFoundException",
                  "InvalidParameterException",
                  "AccessDeniedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            labelDetection: yield* getLabelDetection(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                [
                  "ResourceNotFoundException",
                  "InvalidParameterException",
                  "AccessDeniedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            personTracking: yield* getPersonTracking(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                [
                  "ResourceNotFoundException",
                  "InvalidParameterException",
                  "AccessDeniedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            segmentDetection: yield* getSegmentDetection(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                [
                  "ResourceNotFoundException",
                  "InvalidParameterException",
                  "AccessDeniedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
            textDetection: yield* getTextDetection(probe).pipe(
              Effect.map(() => "Found"),
              Effect.catchTag(
                [
                  "ResourceNotFoundException",
                  "InvalidParameterException",
                  "AccessDeniedException",
                ],
                (e) => Effect.succeed(e._tag),
              ),
            ),
          };
          return yield* HttpServerResponse.json(tags);
        }

        // Media analysis: list for real, start/get through typed error paths.
        if (request.method === "POST" && pathname === "/media-analysis") {
          const jobCount = (
            (yield* listMediaAnalysisJobs({ MaxResults: 10 }))
              .MediaAnalysisJobs ?? []
          ).length;
          const startTag = yield* startMediaAnalysisJob({
            OperationsConfig: {
              DetectModerationLabels: { MinConfidence: 60 },
            },
            Input: {
              S3Object: { Bucket: BOGUS_BUCKET, Name: "manifest.jsonl" },
            },
            OutputConfig: { S3Bucket: BOGUS_BUCKET, S3KeyPrefix: "out/" },
          }).pipe(
            Effect.map(() => "Started"),
            Effect.catchTag(
              [
                "InvalidS3ObjectException",
                "InvalidManifestException",
                "InvalidParameterException",
                "ResourceNotFoundException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const getTag = yield* getMediaAnalysisJob({
            JobId: BOGUS_JOB_ID,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParameterException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ jobCount, startTag, getTag });
        }

        // Stream processors: list for real, control plane through the typed
        // ResourceNotFoundException path.
        if (request.method === "GET" && pathname === "/stream-processors") {
          const count = (
            (yield* listStreamProcessors({ MaxResults: 10 }))
              .StreamProcessors ?? []
          ).length;
          const describeTag = yield* describeStreamProcessor({
            Name: "alchemy-nonexistent-processor",
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const startTag = yield* startStreamProcessor({
            Name: "alchemy-nonexistent-processor",
          }).pipe(
            Effect.map(() => "Started"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          const stopTag = yield* stopStreamProcessor({
            Name: "alchemy-nonexistent-processor",
          }).pipe(
            Effect.map(() => "Stopped"),
            Effect.catchTag("ResourceNotFoundException", (e) =>
              Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({
            count,
            describeTag,
            startTag,
            stopTag,
          });
        }

        // Custom Labels: DescribeProjects for real; the model-scoped ops run
        // through their typed ResourceNotFoundException path with well-formed
        // same-account ARNs (?account=… is passed by the test, parsed from the
        // deployed function's ARN). Custom Labels is closed to new customers,
        // so entitlement-gated accounts may surface the typed
        // AccessDeniedException instead — the test accepts both.
        if (request.method === "GET" && pathname === "/custom-labels") {
          const account = url.searchParams.get("account") ?? "123456789012";
          const region = yield* Effect.sync(
            () => process.env.AWS_REGION ?? "us-east-1",
          );
          const projectArn = `arn:aws:rekognition:${region}:${account}:project/alchemy-nonexistent/1700000000000`;
          const projectVersionArn = `arn:aws:rekognition:${region}:${account}:project/alchemy-nonexistent/version/alchemy-nonexistent/1700000000000`;
          const projectCount = (
            (yield* describeProjects({ MaxResults: 10 })).ProjectDescriptions ??
            []
          ).length;
          const describeVersionsTag = yield* describeProjectVersions({
            ProjectArn: projectArn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const detectTag = yield* detectCustomLabels({
            ProjectVersionArn: projectVersionArn,
            Image: { Bytes: imageBytes },
          }).pipe(
            Effect.map(() => "Detected"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const startTag = yield* startProjectVersion({
            ProjectVersionArn: projectVersionArn,
            MinInferenceUnits: 1,
          }).pipe(
            Effect.map(() => "Started"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const stopTag = yield* stopProjectVersion({
            ProjectVersionArn: projectVersionArn,
          }).pipe(
            Effect.map(() => "Stopped"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParameterException",
                "AccessDeniedException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({
            projectCount,
            describeVersionsTag,
            detectTag,
            startTag,
            stopTag,
          });
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
        Rekognition.CompareFacesHttp,
        Rekognition.DetectFacesHttp,
        Rekognition.DetectLabelsHttp,
        Rekognition.DetectModerationLabelsHttp,
        Rekognition.DetectProtectiveEquipmentHttp,
        Rekognition.DetectTextHttp,
        Rekognition.RecognizeCelebritiesHttp,
        Rekognition.GetCelebrityInfoHttp,
        Rekognition.CreateCollectionHttp,
        Rekognition.DeleteCollectionHttp,
        Rekognition.DescribeCollectionHttp,
        Rekognition.ListCollectionsHttp,
        Rekognition.IndexFacesHttp,
        Rekognition.ListFacesHttp,
        Rekognition.DeleteFacesHttp,
        Rekognition.SearchFacesHttp,
        Rekognition.SearchFacesByImageHttp,
        Rekognition.CreateUserHttp,
        Rekognition.DeleteUserHttp,
        Rekognition.ListUsersHttp,
        Rekognition.AssociateFacesHttp,
        Rekognition.DisassociateFacesHttp,
        Rekognition.SearchUsersHttp,
        Rekognition.SearchUsersByImageHttp,
        Rekognition.CreateFaceLivenessSessionHttp,
        Rekognition.GetFaceLivenessSessionResultsHttp,
        Rekognition.StartCelebrityRecognitionHttp,
        Rekognition.GetCelebrityRecognitionHttp,
        Rekognition.StartContentModerationHttp,
        Rekognition.GetContentModerationHttp,
        Rekognition.StartFaceDetectionHttp,
        Rekognition.GetFaceDetectionHttp,
        Rekognition.StartFaceSearchHttp,
        Rekognition.GetFaceSearchHttp,
        Rekognition.StartLabelDetectionHttp,
        Rekognition.GetLabelDetectionHttp,
        Rekognition.StartPersonTrackingHttp,
        Rekognition.GetPersonTrackingHttp,
        Rekognition.StartSegmentDetectionHttp,
        Rekognition.GetSegmentDetectionHttp,
        Rekognition.StartTextDetectionHttp,
        Rekognition.GetTextDetectionHttp,
        Rekognition.StartMediaAnalysisJobHttp,
        Rekognition.GetMediaAnalysisJobHttp,
        Rekognition.ListMediaAnalysisJobsHttp,
        Rekognition.StartStreamProcessorHttp,
        Rekognition.StopStreamProcessorHttp,
        Rekognition.DescribeStreamProcessorHttp,
        Rekognition.ListStreamProcessorsHttp,
        Rekognition.DetectCustomLabelsHttp,
        Rekognition.DescribeProjectsHttp,
        Rekognition.DescribeProjectVersionsHttp,
        Rekognition.StartProjectVersionHttp,
        Rekognition.StopProjectVersionHttp,
      ),
    ),
  ),
);
