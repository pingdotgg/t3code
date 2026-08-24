import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as kendra from "@distilled.cloud/aws/kendra";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import KendraTestFunctionLive, { KendraTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// A well-formed-but-nonexistent index/data-source id the ungated probes are
// driven against.
const NONEXISTENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// Ungated typed-error probes: every operation the twenty-three bindings wrap
// is exercised directly through distilled against a nonexistent index, and
// must answer with a typed tag. These prove the distilled error unions (and
// request serialization) at near-zero cost on every CI pass, while the full
// runtime fixture below is gated behind the 20-30 minute index provisioning.
// ---------------------------------------------------------------------------

describe("Kendra binding operations (typed-error probes)", () => {
  const expectTag = (error: { _tag: string }, tags: readonly string[]) =>
    expect(tags).toContain(error._tag);
  const NOT_FOUND = ["ResourceNotFoundException"] as const;
  // Operations whose body preconditions may be validated before the index
  // lookup surface either tag.
  const NOT_FOUND_OR_INVALID = [
    "ResourceNotFoundException",
    "ValidationException",
  ] as const;

  test.provider("query yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.query({ IndexId: NONEXISTENT, QueryText: "probe" }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("retrieve yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.retrieve({ IndexId: NONEXISTENT, QueryText: "probe" }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("getQuerySuggestions yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.getQuerySuggestions({
          IndexId: NONEXISTENT,
          QueryText: "probe",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("submitFeedback yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.submitFeedback({
          IndexId: NONEXISTENT,
          QueryId: "probe-query-id",
          ClickFeedbackItems: [
            { ResultId: "probe-result", ClickTime: new Date() },
          ],
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("batchPutDocument yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.batchPutDocument({
          IndexId: NONEXISTENT,
          Documents: [
            {
              Id: "probe",
              Blob: new TextEncoder().encode("probe"),
              ContentType: "PLAIN_TEXT",
            },
          ],
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("batchDeleteDocument yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.batchDeleteDocument({
          IndexId: NONEXISTENT,
          DocumentIdList: ["probe"],
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("batchGetDocumentStatus yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.batchGetDocumentStatus({
          IndexId: NONEXISTENT,
          DocumentInfoList: [{ DocumentId: "probe" }],
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("getSnapshots yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.getSnapshots({
          IndexId: NONEXISTENT,
          Interval: "ONE_WEEK_AGO",
          MetricType: "QUERIES_BY_COUNT",
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("putPrincipalMapping yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.putPrincipalMapping({
          IndexId: NONEXISTENT,
          GroupId: "probe",
          GroupMembers: {
            MemberUsers: [{ UserId: "probe@example.com" }],
          },
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("deletePrincipalMapping yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.deletePrincipalMapping({
          IndexId: NONEXISTENT,
          GroupId: "probe",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("describePrincipalMapping yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.describePrincipalMapping({
          IndexId: NONEXISTENT,
          GroupId: "probe",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider(
    "listGroupsOlderThanOrderingId yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          kendra.listGroupsOlderThanOrderingId({
            IndexId: NONEXISTENT,
            OrderingId: 1,
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider("clearQuerySuggestions yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.clearQuerySuggestions({ IndexId: NONEXISTENT }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider(
    "describeQuerySuggestionsConfig yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          kendra.describeQuerySuggestionsConfig({ IndexId: NONEXISTENT }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider(
    "updateQuerySuggestionsConfig yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          kendra.updateQuerySuggestionsConfig({
            IndexId: NONEXISTENT,
            Mode: "LEARN_ONLY",
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider("createAccessControlConfiguration yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.createAccessControlConfiguration({
          IndexId: NONEXISTENT,
          Name: "probe",
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider(
    "describeAccessControlConfiguration yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          kendra.describeAccessControlConfiguration({
            IndexId: NONEXISTENT,
            Id: "probe",
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider(
    "updateAccessControlConfiguration yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          kendra.updateAccessControlConfiguration({
            IndexId: NONEXISTENT,
            Id: "probe",
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider(
    "deleteAccessControlConfiguration yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          kendra.deleteAccessControlConfiguration({
            IndexId: NONEXISTENT,
            Id: "probe",
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider(
    "listAccessControlConfigurations yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          kendra.listAccessControlConfigurations({ IndexId: NONEXISTENT }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider("startDataSourceSyncJob yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.startDataSourceSyncJob({
          IndexId: NONEXISTENT,
          Id: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("stopDataSourceSyncJob yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.stopDataSourceSyncJob({
          IndexId: NONEXISTENT,
          Id: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("listDataSourceSyncJobs yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        kendra.listDataSourceSyncJobs({
          IndexId: NONEXISTENT,
          Id: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );
});

// ---------------------------------------------------------------------------
// Full runtime fixture: a Lambda bound to all twenty-three bindings against a
// live Developer-edition index + S3 data source. An index takes ~20-30
// minutes to provision and bills hourly once ACTIVE, so this is gated behind
// AWS_TEST_SLOW=1 (same gate as the Index lifecycle test) and always destroys
// what it created.
// ---------------------------------------------------------------------------

const sharedStack = Core.scratchStack(testOptions, "KendraBindings");

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "all bindings against a live index + data source",
  () =>
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* KendraTestFunction;
          }).pipe(Effect.provide(KendraTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        const getJson = (path: string) =>
          HttpClient.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((response) =>
              response.status >= 500
                ? Effect.fail(
                    new Error(`transient upstream ${response.status}`),
                  )
                : Effect.succeed(response),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // All twenty-three capabilities initialized in the runtime.
        const bindings = (yield* getJson("/bindings")) as { bound: string[] };
        expect(bindings.bound).toHaveLength(23);

        // BatchPutDocument — proves IndexId injection + the IAM grant.
        const put = (yield* getJson("/put-documents")) as {
          failed?: number;
          errorTag?: string;
        };
        expect(put.errorTag).toBeUndefined();
        expect(put.failed).toBe(0);

        // BatchGetDocumentStatus — poll (bounded) until the pushed document
        // leaves the processing states.
        const status = yield* getJson("/document-status").pipe(
          Effect.map((r) => (r as { status?: string }).status ?? "UNKNOWN"),
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (s): boolean => s === "INDEXED" || s === "FAILED",
            times: 40,
          }),
        );
        expect(status).toBe("INDEXED");

        // Query — the pushed document is searchable.
        const queried = (yield* getJson("/query?q=zanzibar")) as {
          queryId?: string;
          resultId?: string;
          count?: number;
          errorTag?: string;
        };
        expect(queried.errorTag).toBeUndefined();
        expect(queried.queryId).toBeTruthy();
        expect(queried.count).toBeGreaterThanOrEqual(1);

        // SubmitFeedback for the query's first result.
        const feedback = (yield* getJson(
          `/feedback?queryId=${queried.queryId}&resultId=${queried.resultId}`,
        )) as { ok?: boolean; errorTag?: string };
        expect(feedback.errorTag).toBeUndefined();

        // Retrieve — passage retrieval over the same document.
        const retrieved = (yield* getJson("/retrieve?q=zanzibar")) as {
          count?: number;
          errorTag?: string;
        };
        expect(retrieved.errorTag).toBeUndefined();

        // GetQuerySuggestions (suggestions build from query history so an
        // empty list is fine — no typed error is the assertion).
        const suggested = (yield* getJson("/suggest?q=zanzi")) as {
          count?: number;
          errorTag?: string;
        };
        expect(suggested.errorTag).toBeUndefined();

        // Query-suggestions config read + Duration-typed update + clear.
        const config = (yield* getJson("/suggestions-config")) as {
          mode?: string;
          errorTag?: string;
        };
        expect(config.errorTag).toBeUndefined();
        expect(config.mode).toBeTruthy();
        const updatedSuggestions = (yield* getJson("/update-suggestions")) as {
          ok?: boolean;
          errorTag?: string;
        };
        expect(updatedSuggestions.errorTag).toBeUndefined();
        const cleared = (yield* getJson("/clear-suggestions")) as {
          ok?: boolean;
          errorTag?: string;
        };
        expect(cleared.errorTag).toBeUndefined();

        // Access-control configuration create/describe/update/delete round
        // trip.
        const acl = (yield* getJson("/access-control")) as {
          id?: string;
          name?: string;
          errorTag?: string;
        };
        expect(acl.errorTag).toBeUndefined();
        expect(acl.id).toBeTruthy();
        expect(acl.name).toBe("block-departed-users");
        const acls = (yield* getJson("/access-controls")) as {
          count?: number;
          errorTag?: string;
        };
        expect(acls.errorTag).toBeUndefined();

        // Principal mapping put + describe, then delete.
        const mapping = (yield* getJson("/principal-mapping")) as {
          actions?: number;
          errorTag?: string;
        };
        expect(mapping.errorTag).toBeUndefined();
        expect(mapping.actions).toBeGreaterThanOrEqual(1);
        const stale = (yield* getJson("/stale-groups")) as {
          count?: number;
          errorTag?: string;
        };
        expect(stale.errorTag).toBeUndefined();
        const unmapped = (yield* getJson("/delete-principal-mapping")) as {
          ok?: boolean;
          errorTag?: string;
        };
        expect(unmapped.errorTag).toBeUndefined();

        // Data-source sync trio: start, observe in history, stop.
        const sync = (yield* getJson("/sync")) as {
          executionId?: string;
          errorTag?: string;
        };
        expect(sync.errorTag).toBeUndefined();
        expect(sync.executionId).toBeTruthy();
        const jobs = yield* getJson("/sync-jobs").pipe(
          Effect.map((r) => (r as { count?: number }).count ?? 0),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (count): boolean => count >= 1,
            times: 18,
          }),
        );
        expect(jobs).toBeGreaterThanOrEqual(1);
        // Stopping is best-effort: the sync may already have finished, which
        // Kendra answers with a typed error we accept.
        const stopped = (yield* getJson("/stop-sync")) as {
          ok?: boolean;
          errorTag?: string;
        };
        if (stopped.errorTag !== undefined) {
          expect([
            "ResourceNotFoundException",
            "ConflictException",
            "ValidationException",
          ]).toContain(stopped.errorTag);
        }

        // GetSnapshots — search analytics for the index.
        const snapshots = (yield* getJson("/snapshots")) as {
          header?: string[];
          errorTag?: string;
        };
        expect(snapshots.errorTag).toBeUndefined();

        // BatchDeleteDocument cleanup.
        const deleted = (yield* getJson("/delete-documents")) as {
          failed?: number;
          errorTag?: string;
        };
        expect(deleted.errorTag).toBeUndefined();
        expect(deleted.failed).toBe(0);
      }).pipe(Effect.ensuring(sharedStack.destroy().pipe(Effect.orDie)));
    }),
  // index create (~20-30 min) + document indexing + sync + delete wait.
  { timeout: 5_400_000 },
);
