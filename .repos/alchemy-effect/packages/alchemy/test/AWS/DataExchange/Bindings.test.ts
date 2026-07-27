import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
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
    }),
    { timeout: 240_000 },
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
          const response = (yield* postJson("/import")) as {
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
      { timeout: 150_000 },
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
          const response = (yield* postJson("/notify")) as {
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
