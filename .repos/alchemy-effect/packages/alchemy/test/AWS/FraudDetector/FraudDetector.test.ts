import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import FraudDetectorTestFunctionLive, {
  FRAUD_EMAIL,
  FraudDetectorTestFunction,
  REVIEW_OUTCOME,
  SEED_BLOCKED_IP,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// The standing test account has no frauddetector:* IAM grant, so every live
// call surfaces AccessDeniedException. The full rule-based E2E is gated behind
// AWS_TEST_FRAUDDETECTOR=1 and runs unchanged in an entitled account; an
// ungated typed-error probe proves credentials reach the service and the SDK
// decodes a typed error either way.
const RUN_LIVE = !!process.env.AWS_TEST_FRAUDDETECTOR;

// Ungated typed-error probe: proves credentials reach Fraud Detector and the
// SDK decodes a typed error. In an entitled account the missing detector
// surfaces as ResourceNotFoundException; an ungranted account surfaces
// AccessDeniedException. Either way the boundary is a typed tag.
test.provider("getDetectors on a nonexistent id fails with a typed error", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      frauddetector.getDetectors({ detectorId: "does_not_exist_detector" }),
    );
    expect(
      ["ResourceNotFoundException", "AccessDeniedException"].includes(
        error._tag,
      ),
    ).toBe(true);
  }),
);

// Ungated typed-error probe for the event data plane: getEvent on a
// nonexistent event type decodes to a typed tag (ResourceNotFoundException in
// an entitled account, AccessDeniedException in an ungranted one).
test.provider(
  "getEvent on a nonexistent event type fails with a typed error",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        frauddetector.getEvent({
          eventId: "does-not-exist",
          eventTypeName: "does_not_exist_event_type",
        }),
      );
      expect(
        ["ResourceNotFoundException", "AccessDeniedException"].includes(
          error._tag,
        ),
      ).toBe(true);
    }),
);

// Ungated typed-error probe for the list data plane: updateList on a
// nonexistent list decodes to a typed tag (ResourceNotFoundException in an
// entitled account, AccessDeniedException in an ungranted one).
test.provider("updateList on a nonexistent list fails with a typed error", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      frauddetector.updateList({
        name: "does_not_exist_list",
        elements: ["203.0.113.1"],
        updateMode: "REPLACE",
      }),
    );
    expect(
      ["ResourceNotFoundException", "AccessDeniedException"].includes(
        error._tag,
      ),
    ).toBe(true);
  }),
);

const sharedStack = Core.scratchStack(testOptions, "FraudDetectorPrediction");

let baseUrl: string;

describe("FraudDetector GetEventPrediction (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("FraudDetector E2E setup: destroying previous run");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "FraudDetector E2E setup: deploying entity type + variables + outcome + event type + detector + active version + Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* FraudDetectorTestFunction;
        }).pipe(Effect.provide(FraudDetectorTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
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
    "a fraud email is scored and returns the review outcome",
    () =>
      Effect.gen(function* () {
        // The detector version may take a moment to become ACTIVE after
        // deploy; retry through transient 5xx while it settles.
        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/predict`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ email: FRAUD_EMAIL }),
          ),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new Error(`predict failed: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("2 seconds"),
              Schedule.recurs(8),
            ]),
          }),
        );
        const body = (yield* response.json) as { outcomes: string[] };
        expect(body.outcomes).toContain(REVIEW_OUTCOME);
      }),
    { timeout: 180_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "a benign email matches no rule and returns no outcome",
    () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/predict`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ email: "legit@example.com" }),
          ),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res)
              : Effect.fail(new Error(`predict failed: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("2 seconds"),
              Schedule.recurs(8),
            ]),
          }),
        );
        const body = (yield* response.json) as { outcomes: string[] };
        expect(body.outcomes).not.toContain(REVIEW_OUTCOME);
      }),
    { timeout: 180_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "a stored event can be sent, read, labeled, and deleted",
    () =>
      Effect.gen(function* () {
        const eventId = "alchemy-e2e-stored-event-1";
        const client = yield* HttpClient.HttpClient;

        const post = (path: string, body: unknown) =>
          client
            .execute(
              HttpClientRequest.post(`${baseUrl}${path}`).pipe(
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            )
            .pipe(
              Effect.flatMap((res) =>
                res.status === 200
                  ? Effect.succeed(res)
                  : Effect.fail(new Error(`${path} failed: ${res.status}`)),
              ),
              Effect.retry({
                schedule: Schedule.max([
                  Schedule.exponential("2 seconds"),
                  Schedule.recurs(6),
                ]),
              }),
            );

        const readEvent = client
          .get(`${baseUrl}/event?id=${eventId}`)
          .pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.flatMap(res.json, (body) =>
                    Effect.succeed(
                      body as { found: boolean; currentLabel?: string },
                    ),
                  )
                : Effect.fail(new Error(`get event failed: ${res.status}`)),
            ),
          );

        // Ingest, then poll until the stored event is readable (ingestion is
        // eventually consistent).
        yield* post("/event", { eventId, email: "legit@example.com" });
        const stored = yield* readEvent.pipe(
          Effect.retry({
            schedule: Schedule.max([
              Schedule.spaced("3 seconds"),
              Schedule.recurs(10),
            ]),
            while: (e): boolean => e instanceof Error,
          }),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (body): boolean => body.found,
            times: 10,
          }),
        );
        expect(stored.found).toBe(true);

        // Label the stored event, then observe the label on read-back.
        yield* post("/event/label", { eventId });
        const labeled = yield* readEvent.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (body): boolean => body.currentLabel !== undefined,
            times: 10,
          }),
        );
        expect(labeled.currentLabel).toBeTruthy();

        // Delete the stored event, then observe it gone.
        const deleted = yield* client
          .del(`${baseUrl}/event?id=${eventId}`)
          .pipe(Effect.flatMap((res) => Effect.succeed(res.status)));
        expect(deleted).toBe(200);
        const gone = yield* readEvent.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (body): boolean => !body.found,
            times: 10,
          }),
        );
        expect(gone.found).toBe(false);
      }),
    { timeout: 180_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "the deny-list is readable and appendable at runtime",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const readList = client
          .get(`${baseUrl}/list`)
          .pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.flatMap(res.json, (body) =>
                    Effect.succeed(body as { elements: string[] }),
                  )
                : Effect.fail(new Error(`get list failed: ${res.status}`)),
            ),
          );

        // The seeded element from the List resource is readable.
        const seeded = yield* readList.pipe(
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("2 seconds"),
              Schedule.recurs(6),
            ]),
          }),
        );
        expect(seeded.elements).toContain(SEED_BLOCKED_IP);

        // Append a new element at runtime, then observe it on read-back.
        const appended = "198.51.100.77";
        const post = yield* client.execute(
          HttpClientRequest.post(`${baseUrl}/list/append`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ element: appended }),
          ),
        );
        expect(post.status).toBe(200);
        const after = yield* readList.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (body): boolean => body.elements.includes(appended),
            times: 10,
          }),
        );
        expect(after.elements).toContain(appended);
        expect(after.elements).toContain(SEED_BLOCKED_IP);
      }),
    { timeout: 180_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "past predictions can be listed and audited",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const eventId = "alchemy-e2e-audited-prediction-1";

        // Make a prediction with a known event id.
        yield* client
          .execute(
            HttpClientRequest.post(`${baseUrl}/predict`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                email: FRAUD_EMAIL,
                eventId,
              }),
            ),
          )
          .pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.succeed(res)
                : Effect.fail(new Error(`predict failed: ${res.status}`)),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("2 seconds"),
                Schedule.recurs(6),
              ]),
            }),
          );

        // The prediction shows up in ListEventPredictions eventually.
        const listed = yield* client
          .get(`${baseUrl}/predictions?eventId=${eventId}`)
          .pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.flatMap(res.json, (body) =>
                    Effect.succeed(body as { summaries: unknown[] }),
                  )
                : Effect.fail(
                    new Error(`list predictions failed: ${res.status}`),
                  ),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (body): boolean => body.summaries.length > 0,
              times: 10,
            }),
          );
        expect(listed.summaries.length).toBeGreaterThan(0);

        // Its full evaluation metadata is auditable.
        const audit = yield* client
          .get(`${baseUrl}/prediction-metadata?eventId=${eventId}`)
          .pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.flatMap(res.json, (body) =>
                    Effect.succeed(
                      body as {
                        found: boolean;
                        outcomes: string[];
                        ruleCount: number;
                      },
                    ),
                  )
                : Effect.fail(new Error(`audit failed: ${res.status}`)),
            ),
          );
        expect(audit.found).toBe(true);
        expect(audit.outcomes).toContain(REVIEW_OUTCOME);
        expect(audit.ruleCount).toBeGreaterThan(0);
      }),
    { timeout: 180_000 },
  );

  // Runs LAST — the purge deletes all stored events for the event type.
  test.provider.skipIf(!RUN_LIVE)(
    "stored events can be bulk purged by event type",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;

        const purged = yield* client
          .post(`${baseUrl}/events/purge`)
          .pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.flatMap(res.json, (body) =>
                    Effect.succeed(body as { status?: string }),
                  )
                : Effect.fail(new Error(`purge failed: ${res.status}`)),
            ),
          );
        expect(purged.status).toBeTruthy();

        // The companion status call reports the async deletion job.
        const status = yield* client.get(`${baseUrl}/events/purge-status`).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.flatMap(res.json, (body) =>
                  Effect.succeed(body as { status?: string }),
                )
              : Effect.fail(new Error(`purge status failed: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("2 seconds"),
              Schedule.recurs(6),
            ]),
          }),
        );
        expect(status.status).toBeTruthy();
      }),
    { timeout: 180_000 },
  );
});
