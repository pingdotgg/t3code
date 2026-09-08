import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import DataExchangeTestFunctionLive, {
  DataExchangeTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DataExchangeBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;
let functionName: string | undefined;
let fixtureDataSetId: string | undefined;

// beforeAll/afterAll hooks run outside `test.provider`'s layer, so raw
// distilled calls need the provider layer (credentials, region) supplied
// explicitly.
const aws = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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
        Schedule.exponential("500 millis"),
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

class IamPropagationLag extends Data.TaggedError("IamPropagationLag")<{
  readonly path: string;
}> {}

// A freshly attached IAM policy can lag behind the Lambda's first calls —
// DataExchange then rejects with AccessDeniedException, which the handler
// surfaces as `{ error: "AccessDeniedException" }`. Retry the route through
// the propagation window (bounded ~5.5 minutes — under full-suite load IAM
// propagation for fresh roles routinely exceeds 4 minutes); any other
// outcome surfaces immediately.
const postJsonThroughIamPropagation = (path: string) =>
  postJson(path).pipe(
    Effect.flatMap((body) =>
      (body as { error?: string }).error === "AccessDeniedException"
        ? Effect.fail(new IamPropagationLag({ path }))
        : Effect.succeed(body),
    ),
    Effect.retry({
      while: (e) => e._tag === "IamPropagationLag",
      schedule: Schedule.max([
        Schedule.spaced("10 seconds"),
        Schedule.recurs(33),
      ]),
    }),
  );

describe.sequential("DataExchange Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "DataExchange test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("DataExchange test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* DataExchangeTestFunction;
        }).pipe(Effect.provide(DataExchangeTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;
      functionName = attrs.functionName;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `DataExchange test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `DataExchange test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // Capture the fixture data set's id so afterAll can assert it is gone
      // after the final destroy.
      const dataSet = (yield* getJson("/data-set")) as { id: string };
      fixtureDataSetId = dataSet.id;
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Assert the fixture's data set really is gone (zero orphans).
      if (fixtureDataSetId !== undefined) {
        const gone = yield* Effect.flip(
          aws(dataexchange.getDataSet({ DataSetId: fixtureDataSetId })),
        );
        expect(gone._tag).toBe("ResourceNotFoundException");
      }

      // The Lambda provider reaps /aws/lambda/{name} on delete and watches
      // ~90s for a flush-driven recreation, but this suite invokes the
      // function right up until destroy, and the Lambda service occasionally
      // flushes a final log batch AFTER that watch ends — silently
      // re-creating the just-deleted group. Watch a bit longer here with a
      // bounded observe→delete loop (every delete is idempotent); a flush
      // landing after the final observation is unobservable and the nuke
      // census is the backstop.
      if (functionName !== undefined) {
        const logGroupName = `/aws/lambda/${functionName}`;
        const reapIfObserved = Effect.gen(function* () {
          const present = yield* aws(
            logs.describeLogGroups({
              logGroupNamePrefix: logGroupName,
              limit: 1,
            }),
          ).pipe(
            Effect.map((response) =>
              (response.logGroups ?? []).some(
                (group) => group.logGroupName === logGroupName,
              ),
            ),
          );
          if (present) {
            yield* aws(logs.deleteLogGroup({ logGroupName })).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          }
          return present;
        });
        // Fixed 6 passes over ~100s — do NOT stop on first absence, since an
        // absent group can still be recreated by a late flush.
        yield* reapIfObserved.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("20 seconds"),
            times: 5,
          }),
        );
        const stillPresent = yield* reapIfObserved;
        expect(stillPresent).toBe(false);
      }
    }),
    { timeout: 420_000 },
  );

  describe("binding registration", () => {
    test.provider("all capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toContain("getDataSet");
        expect(response.bound).toContain("createJob");
        expect(response.bound).toContain("listReceivedDataGrants");
        expect(response.bound).toHaveLength(16);
      }),
    );
  });

  describe("GetDataSet", () => {
    test.provider(
      "reads the bound data set's detail (injected data set id)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/data-set")) as {
            id: string;
            name: string;
            assetType: string;
            origin: string;
          };
          expect(response.id).toBeTruthy();
          expect(response.assetType).toBe("S3_SNAPSHOT");
          expect(response.origin).toBe("OWNED");
        }),
    );
  });

  describe("ListDataSetRevisions", () => {
    test.provider("enumerates the bound data set's revisions", (_stack) =>
      Effect.gen(function* () {
        const revision = (yield* getJson("/revision")) as { id: string };
        const response = (yield* getJson("/revisions")) as { ids: string[] };
        expect(response.ids).toContain(revision.id);
      }),
    );
  });

  describe("GetRevision", () => {
    test.provider(
      "reads the bound revision (injected data set + revision ids)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/revision")) as {
            id: string;
            finalized: boolean;
          };
          expect(response.id).toBeTruthy();
          expect(response.finalized).toBe(false);
        }),
    );
  });

  describe("ListDataSets", () => {
    test.provider(
      "enumerates the account's owned data sets including the fixture's",
      (_stack) =>
        Effect.gen(function* () {
          const dataSet = (yield* getJson("/data-set")) as { id: string };
          const response = (yield* getJson("/data-sets")) as { ids: string[] };
          expect(response.ids).toContain(dataSet.id);
        }),
    );
  });

  describe("CreateJob / StartJob / GetJob / ListRevisionAssets / GetAsset", () => {
    test.provider(
      "imports an S3 object into the revision via a job and reads it back",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJsonThroughIamPropagation(
            "/import",
          )) as {
            jobState?: string;
            jobErrors?: unknown[];
            assetCount?: number;
            assetName?: string;
            error?: string;
            message?: string;
          };
          expect(response.error, response.message).toBeUndefined();
          expect(JSON.stringify(response.jobErrors ?? [])).toBe("[]");
          expect(response.jobState).toBe("COMPLETED");
          expect(response.assetCount).toBeGreaterThanOrEqual(1);
          expect(response.assetName).toBe("prices.csv");
        }),
      // Covers the full IAM propagation retry budget (~5.5 min) plus the
      // import job's own create → start → poll-to-COMPLETED runtime.
      { timeout: 480_000 },
    );

    test.provider("ListJobs sees the import job", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/jobs")) as { states: string[] };
        expect(response.states).toContain("COMPLETED");
      }),
    );
  });

  describe("SendDataSetNotification", () => {
    // Provider-generated notifications only work for data sets attached to
    // an AWS Marketplace data product, which cannot be provisioned
    // self-contained. The typed rejection proves the binding's IAM grant,
    // call path, and error decoding end-to-end.
    test.provider(
      "rejects a data set outside a Marketplace product with a typed error",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJsonThroughIamPropagation(
            "/notify",
          )) as {
            ok: boolean;
            error: string | undefined;
            message: string | undefined;
          };
          expect(response.ok).toBe(false);
          expect(response.error).toBe("ValidationException");
          expect(response.message).toContain(
            "not configured for AWS Marketplace",
          );
        }),
      // Shares the IAM propagation retry budget with the /import test.
      { timeout: 420_000 },
    );
  });

  describe("ListDataGrants / ListReceivedDataGrants", () => {
    test.provider("enumerates sent and received data grants", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/grants")) as {
          sent: number;
          received: number;
        };
        expect(response.sent).toBeGreaterThanOrEqual(0);
        expect(response.received).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListEventActions", () => {
    test.provider("enumerates the account's event actions", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/event-actions")) as {
          count: number;
        };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("consumeDataSetEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeDataSetEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
