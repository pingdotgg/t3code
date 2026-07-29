import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { Region } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import TranscribeTestFunctionLive, { TranscribeTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "TranscribeBindings");

// Deterministic fixture names (account-scoped; this suite owns them in the
// testing account). Never derived from Date.now().
const FILTER_NAME = "alchemy-test-transcribe-filter";
const CATEGORY_NAME = "alchemy-test-transcribe-category";
const BOGUS = "alchemy-nonexistent-transcribe-probe";

// Transcribe reports missing jobs as BadRequestException ("The requested job
// couldn't be found.") rather than NotFoundException — a documented API
// quirk. Missing vocabularies/models surface NotFoundException. Both tags
// are typed; routes below assert the observed one (or either where AWS is
// inconsistent across families).
const NOT_FOUND_TAGS = ["NotFoundException", "BadRequestException"];

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx (cold
// re-init that the handler's `Effect.orDie` surfaces as a 500). Retry only
// 5xx; a genuine 4xx surfaces immediately.
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
        Schedule.recurs(8),
      ]),
    }),
  );

// A `type` (not `interface`) so it carries an implicit index signature and is
// comparable to the `JsonObject` member of `response.json`'s union.
type RouteResult = {
  ok: boolean;
  error?: string;
  count?: number;
  status?: string;
  state?: string;
  name?: string;
  rules?: number;
  downloadUri?: string;
};

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
    Effect.map((r) => r as RouteResult),
  );

const postJson = (path: string, body: object) =>
  send(
    HttpClientRequest.post(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(
    Effect.flatMap((r) => r.json),
    Effect.map((r) => r as RouteResult),
  );

// Freshly attached IAM policies (especially the iam:PassRole grants on the
// data-access role) can take a few seconds to propagate; retry any route
// that answers with the typed AccessDeniedException, bounded well under a
// minute.
const untilAuthorized = <E, R>(effect: Effect.Effect<RouteResult, E, R>) =>
  effect.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (r): boolean => r.error !== "AccessDeniedException",
      times: 10,
    }),
  );

describe.sequential("Transcribe Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Transcribe test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Transcribe test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* TranscribeTestFunction;
        }).pipe(Effect.provide(TranscribeTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds (sometimes over a
      // minute) to serve 200s.
      yield* HttpClient.get(`${baseUrl}/jobs`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("List bindings", () => {
    test.provider(
      "all nine list bindings answer from the runtime",
      () =>
        Effect.gen(function* () {
          for (const path of [
            "/jobs",
            "/callJobs",
            "/medicalJobs",
            "/vocabularies",
            "/medicalVocabularies",
            "/filters",
            "/categories",
            "/languageModels",
          ]) {
            const body = yield* getJson(path);
            expect(body.error, path).toBeUndefined();
            expect(typeof body.count, path).toBe("number");
          }

          // AWS HealthScribe is not available in every region (e.g.
          // us-west-2): unavailable regions answer with a typed
          // BadRequestException ("Your account isn't authorized to call this
          // operation"). Either a count or that typed tag proves the binding
          // + grant end-to-end — an IAM gap would be AccessDeniedException.
          const scribe = yield* getJson("/scribeJobs");
          expect(
            scribe.error === undefined ||
              scribe.error === "BadRequestException",
            `/scribeJobs: ${scribe.error}`,
          ).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("Get bindings (typed not-found tags)", () => {
    test.provider(
      "reading nonexistent jobs/vocabularies/models surfaces typed tags",
      () =>
        Effect.gen(function* () {
          // A typed not-found tag (never AccessDenied, never a 500) proves
          // the grant and the typed error mapping end-to-end per binding.
          const job = yield* getJson(`/job?name=${BOGUS}`);
          expect(job.error).toBe("BadRequestException");

          for (const path of [
            "/callJob",
            "/medicalJob",
            "/scribeJob",
            "/vocabulary",
            "/medicalVocabulary",
            "/languageModel",
          ]) {
            const body = yield* getJson(`${path}?name=${BOGUS}`);
            expect(NOT_FOUND_TAGS, path).toContain(body.error);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("Delete bindings", () => {
    test.provider(
      "deleting nonexistent resources is idempotent or surfaces typed tags",
      () =>
        Effect.gen(function* () {
          // Transcribe's delete APIs are inconsistent across families: some
          // succeed idempotently for a missing resource, others return a
          // typed not-found tag. Either proves the grant + wire-up; an IAM
          // gap would surface AccessDeniedException instead.
          for (const path of [
            "/job/delete",
            "/callJob/delete",
            "/medicalJob/delete",
            "/scribeJob/delete",
            "/vocabulary/delete",
            "/medicalVocabulary/delete",
            "/languageModel/delete",
          ]) {
            const body = yield* postJson(path, { name: BOGUS });
            expect(
              body.error === undefined || NOT_FOUND_TAGS.includes(body.error),
              `${path}: ${body.error}`,
            ).toBe(true);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("Start/Create bindings (typed validation, nothing created)", () => {
    test.provider(
      "invalid S3 URIs surface typed BadRequestException per family",
      () =>
        Effect.gen(function* () {
          // The invalid `Media`/`VocabularyFileUri` fails Transcribe's
          // server-side pattern validation: the request is authorized (so an
          // IAM gap would surface AccessDenied instead) but nothing is
          // created and nothing is billed. The role-bound bindings
          // (startCall, startScribe, languageModel/create) additionally
          // prove the iam:PassRole wiring.
          for (const path of [
            "/startJob",
            "/startCall",
            "/startMedical",
            "/startScribe",
            "/vocabulary/create",
            "/medicalVocabulary/create",
            "/languageModel/create",
          ]) {
            const body = yield* untilAuthorized(
              postJson(path, { name: BOGUS }),
            );
            expect(body.ok, path).toBe(false);
            expect(body.error, path).toBe("BadRequestException");
          }

          // Updating a nonexistent vocabulary surfaces its typed tag.
          for (const path of [
            "/vocabulary/update",
            "/medicalVocabulary/update",
          ]) {
            const body = yield* postJson(path, { name: BOGUS });
            expect(NOT_FOUND_TAGS, path).toContain(body.error);
          }
        }),
      { timeout: 180_000 },
    );
  });

  describe("VocabularyFilter lifecycle + tagging", () => {
    test.provider(
      "create, get, update, tag, untag, and delete a vocabulary filter",
      () =>
        Effect.gen(function* () {
          // Cleanup leftovers from a crashed prior run (typed tag ignored).
          yield* postJson("/filter/delete", { name: FILTER_NAME });

          const created = yield* postJson("/filter/create", {
            name: FILTER_NAME,
          });
          expect(created.error).toBeUndefined();
          expect(created.name).toBe(FILTER_NAME);

          const got = yield* getJson(`/filter?name=${FILTER_NAME}`);
          expect(got.error).toBeUndefined();
          expect(got.name).toBe(FILTER_NAME);
          expect(got.downloadUri).toBeTruthy();

          const updated = yield* postJson("/filter/update", {
            name: FILTER_NAME,
          });
          expect(updated.error).toBeUndefined();

          // Tag ops address Transcribe resources by ARN.
          const region = yield* yield* Region;
          const identity = yield* sts.getCallerIdentity({});
          const arn = `arn:aws:transcribe:${region}:${identity.Account}:vocabulary-filter/${FILTER_NAME}`;

          const tagged = yield* postJson("/tag", { arn });
          expect(tagged.error).toBeUndefined();

          const tags = yield* getJson(`/tags?arn=${encodeURIComponent(arn)}`);
          expect(tags.error).toBeUndefined();
          expect(tags.count).toBeGreaterThanOrEqual(1);

          const untagged = yield* postJson("/untag", { arn });
          expect(untagged.error).toBeUndefined();

          const deleted = yield* postJson("/filter/delete", {
            name: FILTER_NAME,
          });
          expect(deleted.error).toBeUndefined();

          // Wait until it is really gone (typed tag on the get).
          const gone = yield* getJson(`/filter?name=${FILTER_NAME}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean => r.error !== undefined,
              times: 10,
            }),
          );
          expect(NOT_FOUND_TAGS).toContain(gone.error);
        }),
      { timeout: 120_000 },
    );
  });

  describe("CallAnalyticsCategory lifecycle", () => {
    test.provider(
      "create, get, update, and delete a call analytics category",
      () =>
        Effect.gen(function* () {
          // Cleanup leftovers from a crashed prior run (typed tag ignored).
          yield* postJson("/category/delete", { name: CATEGORY_NAME });

          const created = yield* postJson("/category/create", {
            name: CATEGORY_NAME,
          });
          expect(created.error).toBeUndefined();
          expect(created.name).toBe(CATEGORY_NAME);

          const got = yield* getJson(`/category?name=${CATEGORY_NAME}`);
          expect(got.error).toBeUndefined();
          expect(got.rules).toBe(1);

          const updated = yield* postJson("/category/update", {
            name: CATEGORY_NAME,
          });
          expect(updated.error).toBeUndefined();

          const deleted = yield* postJson("/category/delete", {
            name: CATEGORY_NAME,
          });
          expect(deleted.error).toBeUndefined();

          const gone = yield* getJson(`/category?name=${CATEGORY_NAME}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean => r.error !== undefined,
              times: 10,
            }),
          );
          expect(NOT_FOUND_TAGS).toContain(gone.error);
        }),
      { timeout: 120_000 },
    );
  });

  describe("consumeTranscriptionJobEvents", () => {
    test.provider(
      "created the EventBridge rule for Transcribe job state changes",
      () =>
        Effect.gen(function* () {
          // The rule's physical name embeds the event-source id
          // (`TranscribeJobEvents`); find it on the default bus with bounded
          // manual pagination.
          let rule: eventbridge.Rule | undefined;
          let nextToken: string | undefined;
          for (let page = 0; page < 10 && !rule; page++) {
            const result = yield* eventbridge.listRules({
              NextToken: nextToken,
            });
            rule = (result.Rules ?? []).find((candidate) =>
              candidate.Name?.includes("TranscribeJobEvents"),
            );
            nextToken = result.NextToken;
            if (!nextToken) break;
          }
          expect(rule).toBeDefined();
          expect(rule?.EventPattern).toContain("aws.transcribe");
          expect(rule?.EventPattern).toContain("Transcribe Job State Change");
        }),
      { timeout: 60_000 },
    );
  });
});
