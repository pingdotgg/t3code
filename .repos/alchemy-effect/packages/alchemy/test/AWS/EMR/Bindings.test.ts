import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import EmrTestFunctionLive, {
  EmrTestFunction,
  PROBE_RELEASE_LABEL,
} from "./handler";
import EmrSlowTestFunctionLive, { EmrSlowTestFunction } from "./slow-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "EMRBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx (cold
// re-init, IAM propagation on the freshly attached policy that the handler's
// `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine 4xx surfaces
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
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("EMR Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("EMR test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("EMR test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* EmrTestFunction;
        }).pipe(Effect.provide(EmrTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all four capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(4);
      }),
    );
  });

  describe("ListClusters", () => {
    test.provider("lists the account's active clusters", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/clusters")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("ListReleaseLabels", () => {
    test.provider("lists the region's release catalog, newest first", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/releases")) as {
          count: number;
          latest?: string;
        };
        expect(response.count).toBeGreaterThan(0);
        expect(response.latest).toMatch(/^emr-/);
      }),
    );
  });

  describe("DescribeReleaseLabel", () => {
    test.provider("reads the applications a release ships", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/release")) as {
          applications: string[];
        };
        expect(response.applications).toContain("Spark");
      }),
    );
  });

  describe("ListSupportedInstanceTypes", () => {
    test.provider(`lists instance types for ${PROBE_RELEASE_LABEL}`, () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/instance-types")) as {
          types: string[];
        };
        expect(response.types.length).toBeGreaterThan(0);
      }),
    );
  });

  describe("consumeClusterEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeClusterEvents
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

// ---------------------------------------------------------------------------
// Cluster-scoped bindings (steps data plane, inspection reads, managed
// scaling) need a real EMR cluster (~10-15 min to WAITING, billed per
// instance-hour) — gated behind AWS_TEST_SLOW=1 like the Cluster lifecycle
// test.
// ---------------------------------------------------------------------------

const slowStack = Core.scratchStack(testOptions, "EMRSlowBindings");

test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "steps + inspection + managed-scaling bindings against a live cluster",
  () =>
    Effect.gen(function* () {
      yield* slowStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* slowStack.deploy(
          Effect.gen(function* () {
            return yield* EmrSlowTestFunction;
          }).pipe(Effect.provide(EmrSlowTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const slowBaseUrl = functionUrl!.replace(/\/+$/, "");

        const get = (path: string) =>
          HttpClient.get(`${slowBaseUrl}${path}`).pipe(
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // Steps data plane: submit, describe (poll until terminal), list,
        // and cancel — proves the JobFlowId/ClusterId injections and grants.
        const added = (yield* get("/steps/add")) as { stepId?: string };
        expect(added.stepId).toMatch(/^s-/);

        const step = (yield* get(`/step?id=${added.stepId}`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (s): boolean =>
              (s as { state?: string }).state !== "PENDING" &&
              (s as { state?: string }).state !== "RUNNING",
            times: 30,
          }),
        )) as { state?: string; name?: string };
        expect(step.name).toBe("alchemy-echo");
        expect(["COMPLETED", "FAILED", "CANCELLED"]).toContain(step.state);

        const steps = (yield* get("/steps")) as { count: number };
        expect(steps.count).toBeGreaterThanOrEqual(1);

        // Cancelling an already-terminal step reports a per-step failure
        // status — either status proves the grant.
        const cancel = (yield* get(`/steps/cancel?id=${added.stepId}`)) as {
          status?: string;
        };
        expect(cancel.status).toBeDefined();

        // Inspection reads.
        const instances = (yield* get("/instances")) as { count: number };
        expect(instances.count).toBeGreaterThanOrEqual(1);
        const groups = (yield* get("/groups")) as { types: string[] };
        expect(groups.types).toContain("MASTER");
        const bootstrap = (yield* get("/bootstrap")) as { count: number };
        expect(bootstrap.count).toBeGreaterThanOrEqual(0);

        // Managed scaling put -> get -> remove (or a typed validation tag on
        // a master-only cluster).
        const scaling = (yield* get("/scaling")) as {
          ok: boolean;
          max?: number;
          tag?: string;
        };
        if (scaling.ok) {
          expect(scaling.max).toBe(4);
        } else {
          expect(scaling.tag).toBe("ValidationException");
        }
      }).pipe(Effect.ensuring(slowStack.destroy().pipe(Effect.orDie)));
    }),
  // cluster create (~10-15 min) + step run + probes + termination initiation.
  { timeout: 2_700_000 },
);
