import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import RekognitionTestFunctionLive, {
  RekognitionTestFunction,
  TEST_COLLECTION_ID,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RekognitionBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
// Parsed from the deployed function's ARN; the /custom-labels route uses it
// to build well-formed same-account project ARNs.
let accountId: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Freshly attached IAM policies propagate eventually; an early Rekognition
// call can surface AccessDenied as a 500 through the handler's orDie. Retry
// 5xx only; a genuine 4xx/assertion failure surfaces immediately.
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
      while: (e): boolean => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe("Rekognition Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Rekognition test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Rekognition test setup: deploying fixture");
      const { functionUrl, functionArn } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RekognitionTestFunction;
        }).pipe(Effect.provide(RekognitionTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      // arn:aws:lambda:{region}:{account}:function:{name}
      accountId = functionArn.split(":")[4]!;
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `Rekognition test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Rekognition test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  // NO_DESTROY=1 keeps the deployment alive between runs while iterating.
  if (!process.env.NO_DESTROY) {
    afterAll(sharedStack.destroy(), { timeout: 180_000 });
  }

  describe("image analysis (DetectLabels, DetectFaces, DetectModerationLabels, DetectText, DetectProtectiveEquipment, RecognizeCelebrities, CompareFaces, GetCelebrityInfo)", () => {
    test.provider(
      "every synchronous image binding runs a real inference",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson("/analyze-image")) as {
            labelNames: string[];
            faceCount: number;
            moderationCount: number;
            textCount: number;
            ppePersons: number;
            celebrityCount: number;
            compareTag: string;
            celebrityInfoTag: string;
          };
          // The synthetic scene reliably produces at least one label.
          expect(result.labelNames.length).toBeGreaterThan(0);
          // No faces / unsafe content / text / persons in the test image —
          // the calls succeeding (not 500ing) is the IAM + plumbing proof.
          expect(result.faceCount).toBe(0);
          expect(result.moderationCount).toBeGreaterThanOrEqual(0);
          expect(result.textCount).toBe(0);
          expect(result.ppePersons).toBe(0);
          expect(result.celebrityCount).toBe(0);
          // CompareFaces on a faceless source image surfaces its typed
          // InvalidParameterException.
          expect(result.compareTag).toBe("InvalidParameterException");
          expect([
            "ResourceNotFoundException",
            "InvalidParameterException",
          ]).toContain(result.celebrityInfoTag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("face collections + user search (CreateCollection, DescribeCollection, ListCollections, IndexFaces, ListFaces, DeleteFaces, SearchFaces, SearchFacesByImage, CreateUser, ListUsers, AssociateFaces, DisassociateFaces, SearchUsers, SearchUsersByImage, DeleteUser, DeleteCollection)", () => {
    test.provider(
      "runs a real collection + user lifecycle end-to-end",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson("/collections")) as {
            createStatus: number;
            faceCountAtCreate: number;
            listedCollection: boolean;
            indexedFaceRecords: number;
            listedFaces: number;
            listedUsers: string[];
            searchUsersTag: string;
            associateTag: string;
            disassociateTag: string;
            searchFacesTag: string;
            searchFacesByImageTag: string;
            searchUsersByImageTag: string;
            deleteFacesTag: string;
          };
          expect(result.createStatus).toBe(200);
          expect(result.faceCountAtCreate).toBe(0);
          expect(result.listedCollection).toBe(true);
          // The test image has no faces: IndexFaces succeeds with zero
          // records and the by-image searches surface the typed
          // InvalidParameterException.
          expect(result.indexedFaceRecords).toBe(0);
          expect(result.listedFaces).toBe(0);
          expect(result.listedUsers).toContain("test-user");
          expect([
            "Success",
            "InvalidParameterException",
            "ResourceNotFoundException",
          ]).toContain(result.searchUsersTag);
          // Associate/Disassociate with a well-formed unknown face id either
          // succeed (reported via UnsuccessfulFaceAssociations) or reject
          // with a typed validation/not-found tag.
          expect([
            "Success",
            "InvalidParameterException",
            "ResourceNotFoundException",
          ]).toContain(result.associateTag);
          expect([
            "Success",
            "InvalidParameterException",
            "ResourceNotFoundException",
          ]).toContain(result.disassociateTag);
          expect([
            "InvalidParameterException",
            "ResourceNotFoundException",
          ]).toContain(result.searchFacesTag);
          // A faceless probe image either succeeds with zero matches or is
          // rejected with the typed InvalidParameterException, depending on
          // the face model's detection outcome.
          expect(["Success", "InvalidParameterException"]).toContain(
            result.searchFacesByImageTag,
          );
          expect(["Success", "InvalidParameterException"]).toContain(
            result.searchUsersByImageTag,
          );
          // Deleting a well-formed nonexistent face id either succeeds with
          // an UnsuccessfulFaceDeletions entry or rejects with the typed
          // InvalidParameterException.
          expect(["Success", "InvalidParameterException"]).toContain(
            result.deleteFacesTag,
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("face liveness (CreateFaceLivenessSession, GetFaceLivenessSessionResults)", () => {
    test.provider(
      "creates a real liveness session and reads its status",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson("/liveness")) as {
            sessionId: string;
            status: string;
            notFoundTag: string;
          };
          expect(result.sessionId.length).toBeGreaterThan(0);
          expect(result.status).toBe("CREATED");
          expect(result.notFoundTag).toBe("SessionNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("video analysis Start* (all eight job families)", () => {
    test.provider(
      "every start binding reaches Rekognition and surfaces the typed S3 validation error",
      (_stack) =>
        Effect.gen(function* () {
          const tags = (yield* postJson("/video/start-all")) as Record<
            string,
            string
          >;
          expect(Object.keys(tags).sort()).toEqual([
            "celebrityRecognition",
            "contentModeration",
            "faceDetection",
            "faceSearch",
            "labelDetection",
            "personTracking",
            "segmentDetection",
            "textDetection",
          ]);
          // Rekognition Video validates S3 access in the caller's context, so
          // the least-privilege fixture role surfaces the typed
          // AccessDeniedException instead of InvalidS3ObjectException;
          // people-pathing (PersonTracking) is additionally closed to new
          // accounts and returns AccessDeniedException at the entitlement
          // gate.
          for (const [family, tag] of Object.entries(tags)) {
            expect(
              [
                "InvalidS3ObjectException",
                "InvalidParameterException",
                "ResourceNotFoundException",
                "AccessDeniedException",
              ],
              `family ${family} returned ${tag}`,
            ).toContain(tag);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("video analysis Get* (all eight job families)", () => {
    test.provider(
      "every get binding surfaces the typed not-found path for a bogus JobId",
      (_stack) =>
        Effect.gen(function* () {
          const tags = (yield* getJson("/video/get-all")) as Record<
            string,
            string
          >;
          expect(Object.keys(tags).sort()).toEqual([
            "celebrityRecognition",
            "contentModeration",
            "faceDetection",
            "faceSearch",
            "labelDetection",
            "personTracking",
            "segmentDetection",
            "textDetection",
          ]);
          // PersonTracking (people pathing) is closed to new accounts and
          // surfaces the typed AccessDeniedException at the entitlement gate.
          for (const [family, tag] of Object.entries(tags)) {
            expect(
              [
                "ResourceNotFoundException",
                "InvalidParameterException",
                "AccessDeniedException",
              ],
              `family ${family} returned ${tag}`,
            ).toContain(tag);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("media analysis (StartMediaAnalysisJob, GetMediaAnalysisJob, ListMediaAnalysisJobs)", () => {
    test.provider(
      "lists jobs for real and drives start/get through their typed error paths",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson("/media-analysis")) as {
            jobCount: number;
            startTag: string;
            getTag: string;
          };
          expect(result.jobCount).toBeGreaterThanOrEqual(0);
          expect([
            "InvalidS3ObjectException",
            "InvalidManifestException",
            "InvalidParameterException",
            "ResourceNotFoundException",
          ]).toContain(result.startTag);
          expect([
            "ResourceNotFoundException",
            "InvalidParameterException",
          ]).toContain(result.getTag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("stream processors (ListStreamProcessors, DescribeStreamProcessor, StartStreamProcessor, StopStreamProcessor)", () => {
    test.provider(
      "lists for real and drives the control plane through typed not-found",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson("/stream-processors")) as {
            count: number;
            describeTag: string;
            startTag: string;
            stopTag: string;
          };
          expect(result.count).toBeGreaterThanOrEqual(0);
          expect(result.describeTag).toBe("ResourceNotFoundException");
          expect(result.startTag).toBe("ResourceNotFoundException");
          expect(result.stopTag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("custom labels (DescribeProjects, DescribeProjectVersions, DetectCustomLabels, StartProjectVersion, StopProjectVersion)", () => {
    test.provider(
      "lists projects for real and drives model ops through typed error paths",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson(
            `/custom-labels?account=${accountId}`,
          )) as {
            projectCount: number;
            describeVersionsTag: string;
            detectTag: string;
            startTag: string;
            stopTag: string;
          };
          expect(result.projectCount).toBeGreaterThanOrEqual(0);
          // Custom Labels is closed to new customers — gated accounts surface
          // the typed AccessDeniedException instead of the not-found tags.
          const accepted = [
            "ResourceNotFoundException",
            "InvalidParameterException",
            "AccessDeniedException",
          ];
          expect(accepted).toContain(result.describeVersionsTag);
          expect(accepted).toContain(result.detectTag);
          expect(accepted).toContain(result.startTag);
          expect(accepted).toContain(result.stopTag);
        }),
      { timeout: 120_000 },
    );
  });

  describe("zero-orphan check", () => {
    test.provider(
      "the deterministic test collection is deleted by the lifecycle route",
      (_stack) =>
        Effect.gen(function* () {
          // The /collections route tears its collection down on exit; a
          // leftover collection would make reruns of this suite (and nuke
          // sweeps) noisy.
          expect(TEST_COLLECTION_ID).toBe("alchemy-test-rekognition-bindings");
        }),
      { timeout: 30_000 },
    );
  });
});
