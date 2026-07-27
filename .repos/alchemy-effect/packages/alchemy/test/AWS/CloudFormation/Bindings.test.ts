import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CfnTestFunctionLive, {
  CfnTestFunction,
  FIXTURE_EXPORT_NAME,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudFormationBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the shared Lambda fixture (cold re-init, IAM
// propagation on the freshly attached cloudformation policy surfaced as a
// 500 by the handler's `Effect.orDie`). Genuine 4xx/assertion failures
// return immediately.
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

const getJson = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((r) => r.json));

describe.sequential("CloudFormation Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("CFN test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CFN test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CfnTestFunction;
        }).pipe(Effect.provide(CfnTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/describe`;

      yield* Effect.logInfo(
        `CFN test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 240_000,
  });

  describe("DescribeStacks", () => {
    test.provider("reads the bound stack's status and outputs", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/describe`)) as any;

        expect(body.stackId).toContain("arn:aws:cloudformation:");
        expect(["CREATE_COMPLETE", "UPDATE_COMPLETE"]).toContain(body.status);
        expect(body.outputs.ParamName).toBeDefined();
      }),
    );
  });

  describe("DescribeStackEvents", () => {
    test.provider("reads the stack's event history", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/events`)) as any;

        expect(body.count).toBeGreaterThan(0);
        expect(Array.isArray(body.statuses)).toBe(true);
      }),
    );
  });

  describe("DescribeStackResources", () => {
    test.provider("resolves a resource's physical id", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/resources`)) as any;

        expect(body.logicalId).toBe("Param");
        expect(body.type).toBe("AWS::SSM::Parameter");
        expect(body.physicalId).toBeTruthy();
      }),
    );
  });

  describe("ListStackResources", () => {
    test.provider("enumerates the stack's resources", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/list-resources`)) as any;

        expect(body.types).toContain("AWS::SSM::Parameter");
      }),
    );
  });

  describe("GetTemplate", () => {
    test.provider("reads the deployed template body", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/template`)) as any;

        expect(body.template).toContain("AWS::SSM::Parameter");
      }),
    );
  });

  describe("DetectStackDrift + DescribeStackDriftDetectionStatus", () => {
    test.provider(
      "starts drift detection and polls it to a terminal status",
      (_stack) =>
        Effect.gen(function* () {
          const started = (yield* send(
            HttpClientRequest.post(`${baseUrl}/drift`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;

          expect(started.detectionId).toBeTruthy();

          // Detection runs asynchronously; poll until it leaves
          // DETECTION_IN_PROGRESS. DETECTION_FAILED is acceptable — the
          // fixture role has no ssm read access, and either terminal status
          // proves the cloudformation:* IAM + binding wiring.
          const status = yield* getJson(
            `${baseUrl}/drift-status?id=${started.detectionId}`,
          ).pipe(
            Effect.flatMap((body: any) =>
              body.detectionStatus === "DETECTION_IN_PROGRESS"
                ? Effect.fail(new DriftInProgress())
                : Effect.succeed(body),
            ),
            Effect.retry({
              while: (e) => e._tag === "DriftInProgress",
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );

          expect(["DETECTION_COMPLETE", "DETECTION_FAILED"]).toContain(
            (status as any).detectionStatus,
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("DescribeStackResourceDrifts", () => {
    test.provider("reads per-resource drift results", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* getJson(`${baseUrl}/resource-drifts`)) as any;

        // Results only exist for resources CloudFormation managed to check;
        // the call succeeding proves the binding + IAM wiring either way.
        expect(Array.isArray(body.drifts)).toBe(true);
      }),
    );
  });

  describe("ListExports", () => {
    test.provider("lists the fixture stack's export", (_stack) =>
      Effect.gen(function* () {
        // Exports are eventually consistent for fresh stacks.
        const body = yield* fetchUntil(
          getJson(`${baseUrl}/exports`),
          (b) =>
            Array.isArray(b?.names) && b.names.includes(FIXTURE_EXPORT_NAME),
        );

        expect((body as any).names).toContain(FIXTURE_EXPORT_NAME);
      }),
    );
  });

  describe("ListImports", () => {
    test.provider(
      "fails with a typed error for an un-imported export",
      (_stack) =>
        Effect.gen(function* () {
          const body = (yield* getJson(
            `${baseUrl}/imports?name=${FIXTURE_EXPORT_NAME}`,
          )) as any;

          // Nothing imports the fixture export — CloudFormation must reject
          // with a TYPED tag (an untyped catch-all would crash into a 500).
          expect(typeof body.errorTag).toBe("string");
          expect(body.errorTag.length).toBeGreaterThan(0);
        }),
    );
  });

  describe("ValidateTemplate", () => {
    test.provider("validates the fixture template", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/validate`),
            {},
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as any;

        expect(Array.isArray(body.parameters)).toBe(true);
        expect(body.errorTag).toBeUndefined();
      }),
    );

    test.provider("rejects an invalid template with a typed error", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/validate`),
            { template: '{"Resources": {}}' },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as any;

        expect(typeof body.errorTag).toBe("string");
        expect(body.errorTag.length).toBeGreaterThan(0);
      }),
    );
  });

  describe("SignalResource", () => {
    test.provider("delivers a signal for a stack resource", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* send(
          HttpClientRequest.post(`${baseUrl}/signal`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;

        // CloudFormation accepts (and ignores) signals for resources that
        // are not waiting on a CreationPolicy — a 200 proves the
        // cloudformation:SignalResource IAM + binding wiring.
        expect(body.ok).toBe(true);
      }),
    );
  });
});

class DriftInProgress extends Data.TaggedError("DriftInProgress") {}

// A request observed not-yet-consistent control-plane state (ListExports
// lags fresh stacks by a few seconds). Retry, bounded.
class BindingNotConsistent extends Data.TaggedError("BindingNotConsistent") {}

const fetchUntil = <A>(
  fetch: Effect.Effect<unknown, any, HttpClient.HttpClient>,
  ready: (body: any) => boolean,
) =>
  fetch.pipe(
    Effect.flatMap((body) =>
      ready(body)
        ? Effect.succeed(body as A)
        : Effect.fail(new BindingNotConsistent()),
    ),
    Effect.retry({
      while: (e) => e._tag === "BindingNotConsistent",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
