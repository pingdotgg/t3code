import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ImageBuilderTestFunctionLive, {
  ImageBuilderTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ImageBuilderBindings");

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

const deleteJson = (path: string) =>
  send(HttpClientRequest.delete(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("ImageBuilder Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ImageBuilder test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ImageBuilder test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ImageBuilderTestFunction;
        }).pipe(Effect.provide(ImageBuilderTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `ImageBuilder test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ImageBuilder test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 180_000 });

  describe("binding registration", () => {
    test.provider("all eighteen capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(18);
        // SendWorkflowStepAction needs a WAIT_FOR_ACTION step and RetryImage
        // a FAILED build — registration/IAM wiring only.
        expect(response.bound).toContain("sendWorkflowStepAction");
        expect(response.bound).toContain("retryImage");
      }),
    );
  });

  describe("GetImagePipeline", () => {
    test.provider(
      "reads the bound pipeline's state (injected pipeline arn)",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/pipeline")) as {
            arn: string;
            name: string;
            status: string;
            timeoutMinutes: number;
          };
          expect(response.arn).toContain(":image-pipeline/");
          expect(response.status).toBe("ENABLED");
          // The fixture's Duration timeout ("1 hour") landed as 60 wire
          // minutes — proves the renamed duration prop converts correctly.
          expect(response.timeoutMinutes).toBe(60);
        }),
    );
  });

  describe("ListImagePipelineImages", () => {
    test.provider("enumerates the pipeline's builds", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/pipeline-images")) as {
          arns: string[];
        };
        expect(Array.isArray(response.arns)).toBe(true);
      }),
    );
  });

  describe("ListImages", () => {
    test.provider("enumerates the account's images", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/images")) as { count: number };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("account-level reads", () => {
    test.provider(
      "ListImageScanFindings + ListImageScanFindingAggregations + ListWaitingWorkflowSteps",
      () =>
        Effect.gen(function* () {
          const findings = (yield* getJson("/scan-findings")) as {
            count: number;
          };
          expect(findings.count).toBeGreaterThanOrEqual(0);

          const aggregations = (yield* getJson("/scan-aggregations")) as {
            count: number;
          };
          expect(aggregations.count).toBeGreaterThanOrEqual(0);

          const waiting = (yield* getJson("/waiting-steps")) as {
            count: number;
          };
          expect(waiting.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("build lifecycle", () => {
    test.provider(
      "Start → Cancel → GetImage → ListWorkflowExecutions → DeleteImage",
      () =>
        Effect.gen(function* () {
          // Kick off a real build of the bound pipeline via the binding.
          const started = (yield* postJson("/build/start")) as {
            imageBuildVersionArn: string;
          };
          expect(started.imageBuildVersionArn).toContain(":image/");
          const arn = encodeURIComponent(started.imageBuildVersionArn);

          const run = Effect.gen(function* () {
            // Cancel it — early build states can briefly reject the
            // cancellation, so retry through the window (bounded).
            const cancelled = yield* postJson(`/build/cancel?arn=${arn}`).pipe(
              Effect.map(
                (body) =>
                  body as { imageBuildVersionArn?: string; reason?: string },
              ),
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (body): boolean =>
                  body.imageBuildVersionArn !== undefined,
                times: 12,
              }),
            );
            expect(cancelled.imageBuildVersionArn).toBe(
              started.imageBuildVersionArn,
            );

            // The build's workflow drill-down responds (may be empty this
            // early in the build).
            const workflows = (yield* getJson(
              `/build/workflows?arn=${arn}`,
            )) as { ids: string[] };
            expect(Array.isArray(workflows.ids)).toBe(true);

            // If the build already spawned a workflow execution, drill into
            // it through the workflow-monitoring bindings.
            const executionId = workflows.ids[0];
            if (executionId !== undefined) {
              const execution = (yield* getJson(
                `/workflow-execution?id=${encodeURIComponent(executionId)}`,
              )) as { id?: string; status?: string };
              expect(execution.id).toBe(executionId);

              const steps = (yield* getJson(
                `/workflow-steps?id=${encodeURIComponent(executionId)}`,
              )) as { ids: string[] };
              expect(Array.isArray(steps.ids)).toBe(true);

              const stepId = steps.ids[0];
              if (stepId !== undefined) {
                const step = (yield* getJson(
                  `/workflow-step?id=${encodeURIComponent(stepId)}`,
                )) as { name?: string; status?: string };
                expect(typeof step.status).toBe("string");
              }
            }

            // The build version shows up under its image version ARN
            // (…:image/{name}/{version} — strip the build-number suffix).
            const imageVersionArn = started.imageBuildVersionArn.replace(
              /\/\d+$/,
              "",
            );
            const versions = (yield* getJson(
              `/build-versions?arn=${encodeURIComponent(imageVersionArn)}`,
            )) as { arns: string[] };
            expect(versions.arns).toContain(started.imageBuildVersionArn);

            // Packages exist only for AVAILABLE builds — this in-flight or
            // cancelled build reports the typed rejection instead.
            const packages = (yield* getJson(`/build/packages?arn=${arn}`)) as {
              count?: number;
              reason?: string;
            };
            expect(
              packages.count !== undefined || packages.reason !== undefined,
            ).toBe(true);

            // Observe the build settle into CANCELLED via the GetImage
            // binding (bounded).
            const settled = yield* getJson(`/build?arn=${arn}`).pipe(
              Effect.map((body) => body as { status?: string }),
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (body): boolean =>
                  body.status === "CANCELLED" || body.status === "FAILED",
                times: 24,
              }),
            );
            expect(settled.status).toBe("CANCELLED");

            // Prune the cancelled build via the DeleteImage binding; poll
            // through the not-yet-deletable window (bounded).
            const deleted = yield* deleteJson(`/build?arn=${arn}`).pipe(
              Effect.map(
                (body) => body as { deleted: boolean; reason?: string },
              ),
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (body): boolean => body.deleted,
                times: 12,
              }),
            );
            expect(deleted.deleted).toBe(true);
          });

          // Zero-orphan guarantee: whatever happens above, the build
          // version is removed out-of-band via distilled before the test
          // ends (idempotent — tolerates the happy path's delete).
          yield* run.pipe(
            Effect.ensuring(
              imagebuilder
                .deleteImage({
                  imageBuildVersionArn: started.imageBuildVersionArn,
                })
                .pipe(
                  Effect.retry({
                    while: (e): boolean =>
                      e._tag === "InvalidRequestException" ||
                      e._tag === "ResourceDependencyException",
                    schedule: Schedule.max([
                      Schedule.fixed("5 seconds"),
                      Schedule.recurs(10),
                    ]),
                  }),
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                  Effect.catch(() => Effect.void),
                ),
            ),
          );
        }),
      { timeout: 240_000 },
    );
  });

  describe("consumeImageEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeImageEvents
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
