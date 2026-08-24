import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import MwaaServerlessTestFunctionLive, {
  BINDINGS_BUCKET_NAME,
  BINDINGS_WORKFLOW_NAME,
  DEFINITION_KEY,
  MwaaServerlessTestFunction,
  WORKFLOW_DEFINITION,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MWAAServerlessBindings");

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
// (cold re-init, IAM propagation on the freshly attached policy). Retry only
// 5xx; a genuine 4xx/assertion failure surfaces immediately.
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

// Direct distilled calls in beforeAll/afterAll run OUTSIDE test.provider, so
// the AWS client context (credentials, region) must be provided explicitly.
const withAws = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Core.withProviders(effect, testOptions, sharedStack.name);

// The definitions bucket + workflow YAML must exist in S3 BEFORE the fixture
// deploys — MWAA Serverless validates the definition at createWorkflow time.
const ensureDefinitionUploaded = Effect.gen(function* () {
  const region = process.env.AWS_REGION ?? "us-west-2";
  yield* s3
    .createBucket({
      Bucket: BINDINGS_BUCKET_NAME,
      ...(region === "us-east-1"
        ? {}
        : {
            CreateBucketConfiguration: {
              LocationConstraint: region,
            },
          }),
    })
    .pipe(Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void));
  yield* s3.putObject({
    Bucket: BINDINGS_BUCKET_NAME,
    Key: DEFINITION_KEY,
    Body: new TextEncoder().encode(WORKFLOW_DEFINITION),
    ContentType: "application/yaml",
  });
});

// Best-effort cleanup: empty and delete the out-of-band definitions bucket,
// and reap any orphaned auto-created log group left by an interrupted run
// (its name embeds a service-assigned random suffix we cannot predict).
const cleanupOutOfBand = Effect.gen(function* () {
  yield* s3
    .deleteObject({ Bucket: BINDINGS_BUCKET_NAME, Key: DEFINITION_KEY })
    .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
  yield* s3
    .deleteBucket({ Bucket: BINDINGS_BUCKET_NAME })
    .pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
  const found = yield* logs.describeLogGroups({
    logGroupNamePrefix: `/aws/mwaa-serverless/${BINDINGS_WORKFLOW_NAME}-`,
  });
  for (const group of found.logGroups ?? []) {
    if (group.logGroupName !== undefined) {
      yield* logs
        .deleteLogGroup({ logGroupName: group.logGroupName })
        .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    }
  }
});

describe.sequential("MWAAServerless Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "MWAAServerless test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "MWAAServerless test setup: uploading workflow definition",
      );
      yield* withAws(ensureDefinitionUploaded);

      yield* Effect.logInfo("MWAAServerless test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MwaaServerlessTestFunction;
        }).pipe(Effect.provide(MwaaServerlessTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `MWAAServerless test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `MWAAServerless test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(
    sharedStack
      .destroy()
      .pipe(Effect.andThen(Effect.orDie(withAws(cleanupOutOfBand)))),
    { timeout: 240_000 },
  );

  describe("binding registration", () => {
    test.provider("all 7 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(7);
      }),
    );
  });

  describe("ListWorkflowRuns", () => {
    test.provider("reads runs through the injected workflow ARN", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/runs")) as { ids: string[] };
        expect(Array.isArray(response.ids)).toBe(true);
      }),
    );
  });

  describe("ListWorkflowVersions", () => {
    test.provider("lists the workflow's versions", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/versions")) as {
          versions: string[];
        };
        expect(response.versions.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  // Typed probes on a nonexistent run: a typed service error (not
  // AccessDeniedException) proves the IAM grant covers the workflow ARN and
  // the ARN was injected from the binding. ListTaskInstances is the
  // exception — the service answers a nonexistent run with an empty list
  // (`ok`), which proves the same thing.
  describe("typed not-found probes", () => {
    const probes: ReadonlyArray<
      readonly [
        name: string,
        method: "GET" | "POST",
        path: string,
        tags: readonly string[],
      ]
    > = [
      [
        "GetWorkflowRun",
        "GET",
        "/run-fake",
        ["ResourceNotFoundException", "ValidationException"],
      ],
      [
        "ListTaskInstances",
        "GET",
        "/tasks-fake",
        ["ok", "ResourceNotFoundException", "ValidationException"],
      ],
      [
        "GetTaskInstance",
        "GET",
        "/task-fake",
        ["ResourceNotFoundException", "ValidationException"],
      ],
      [
        "StopWorkflowRun",
        "POST",
        "/run-stop-fake",
        ["ResourceNotFoundException", "ValidationException"],
      ],
    ] as const;

    for (const [name, method, path, tags] of probes) {
      test.provider(
        `${name} answers with a typed outcome (not AccessDenied)`,
        (_stack) =>
          Effect.gen(function* () {
            const response = (yield* method === "GET"
              ? getJson(path)
              : postJson(path)) as { tag: string; detail: string };
            expect(response.detail).not.toContain("not authorized");
            expect(tags).toContain(response.tag);
          }),
      );
    }
  });

  describe("workflow run round trip", () => {
    test.provider(
      "start a run, observe it, stop it",
      (_stack) =>
        Effect.gen(function* () {
          // 1. StartWorkflowRun — an on-demand run of the fixture workflow.
          const started = (yield* postJson("/run-start")) as {
            runId: string;
            status: string;
          };
          expect(started.runId).toBeTruthy();

          // 2. GetWorkflowRun observes the run through the binding.
          const detail = (yield* getJson(
            `/run-detail?id=${started.runId}`,
          )) as { runId: string; status?: string };
          expect(detail.runId).toBe(started.runId);

          // 3. StopWorkflowRun — a typed outcome either way: `ok` when the
          //    run was still stoppable, or a typed conflict/validation error
          //    if it already reached a terminal state. Reaching the service
          //    (not AccessDenied) is what the binding must prove.
          const stopped = (yield* postJson(
            `/run-stop?id=${started.runId}`,
          )) as { tag: string };
          expect(stopped.tag).not.toBe("AccessDeniedException");

          // 4. The run shows up in ListWorkflowRuns.
          const listed = (yield* getJson("/runs")) as { ids: string[] };
          expect(listed.ids).toContain(started.runId);
        }),
      { timeout: 120_000 },
    );
  });

  describe("consumeWorkflowRunEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeWorkflowRunEvents
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
