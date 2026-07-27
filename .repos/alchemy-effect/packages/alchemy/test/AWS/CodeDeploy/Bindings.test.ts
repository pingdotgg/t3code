import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CodeDeployTestFunctionLive, { CodeDeployTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CodeDeployBindings");

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
// propagation on the freshly attached codedeploy policy surfaced as a 500
// by the handler's `Effect.orDie`). Genuine 4xx/assertion failures return
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

const getJson = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((r) => r.json));

const postJson = (url: string, body: unknown) =>
  send(
    HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
  ).pipe(Effect.flatMap((r) => r.json));

const post = (url: string) =>
  send(HttpClientRequest.post(url)).pipe(Effect.flatMap((r) => r.json));

/**
 * A route answered with a typed error tag. The tag being present proves the
 * binding produced a typed failure (untyped errors crash into a 500), and it
 * not being an authorization tag proves the IAM grant covered the call.
 */
const expectTypedNonAuthz = (body: any) => {
  expect(typeof body.errorTag).toBe("string");
  expect(body.errorTag).not.toBe("AccessDeniedException");
};

/** A route that either succeeded or failed with a typed, authorized tag. */
const expectAuthorized = (body: any) => {
  if (body.errorTag !== undefined) expectTypedNonAuthz(body);
};

// A syntactically plausible, nonexistent deployment id/target id.
const FAKE_DEPLOYMENT_ID = "d-AAAAAAAAA";
const FAKE_TARGET_ID = "alchemy-test-nonexistent-function";

describe.sequential("CodeDeploy Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("CodeDeploy test setup: destroying previous");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CodeDeploy test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CodeDeployTestFunction;
        }).pipe(Effect.provide(CodeDeployTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/deployment/list`;

      yield* Effect.logInfo(
        `CodeDeploy test setup: probing readiness at ${readinessUrl}`,
      );
      // Ready = the function answers 200 AND the freshly attached codedeploy
      // policy has propagated (an AccessDeniedException errorTag means IAM
      // is still converging — keep probing).
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body: any) =>
          body.errorTag === undefined
            ? Effect.succeed(body)
            : Effect.fail(new Error(`IAM not propagated: ${body.errorTag}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 240_000,
  });

  describe("CreateDeployment", () => {
    test.provider(
      "answers the typed RevisionRequiredException without a revision",
      (_stack) =>
        Effect.gen(function* () {
          // No revision — CodeDeploy rejects with the TYPED
          // RevisionRequiredException, which proves the name injection,
          // the binding wiring, and the IAM grant all work.
          const body = (yield* post(`${baseUrl}/deployment/create`)) as any;
          expect(body.errorTag).toBe("RevisionRequiredException");
        }),
    );
  });

  describe("ListDeployments + GetDeployment + BatchGetDeployments", () => {
    test.provider("lists (empty) and answers typed for unknown ids", (_stack) =>
      Effect.gen(function* () {
        const listed = (yield* getJson(`${baseUrl}/deployment/list`)) as any;
        expect(listed.errorTag).toBeUndefined();
        expect(listed.deployments).toEqual([]);

        const got = (yield* getJson(
          `${baseUrl}/deployment/get?id=${FAKE_DEPLOYMENT_ID}`,
        )) as any;
        expectTypedNonAuthz(got);

        const batch = (yield* getJson(
          `${baseUrl}/deployment/batch-get?id=${FAKE_DEPLOYMENT_ID}`,
        )) as any;
        expectAuthorized(batch);
      }),
    );
  });

  describe("StopDeployment + ContinueDeployment + PutLifecycleEventHookExecutionStatus", () => {
    test.provider("answer typed for unknown deployments", (_stack) =>
      Effect.gen(function* () {
        const stopped = (yield* postJson(`${baseUrl}/deployment/stop`, {
          id: FAKE_DEPLOYMENT_ID,
        })) as any;
        expectTypedNonAuthz(stopped);

        const continued = (yield* postJson(`${baseUrl}/deployment/continue`, {
          id: FAKE_DEPLOYMENT_ID,
        })) as any;
        expectTypedNonAuthz(continued);

        const hook = (yield* postJson(`${baseUrl}/hook/status`, {
          deploymentId: FAKE_DEPLOYMENT_ID,
          executionId: "00000000-0000-0000-0000-000000000000",
        })) as any;
        expectTypedNonAuthz(hook);
      }),
    );
  });

  describe("Deployment targets", () => {
    test.provider("target bindings answer typed for unknown ids", (_stack) =>
      Effect.gen(function* () {
        const got = (yield* getJson(
          `${baseUrl}/target/get?deploymentId=${FAKE_DEPLOYMENT_ID}&targetId=${FAKE_TARGET_ID}`,
        )) as any;
        expectTypedNonAuthz(got);

        const listed = (yield* getJson(
          `${baseUrl}/target/list?deploymentId=${FAKE_DEPLOYMENT_ID}`,
        )) as any;
        expectTypedNonAuthz(listed);

        const batch = (yield* getJson(
          `${baseUrl}/target/batch-get?deploymentId=${FAKE_DEPLOYMENT_ID}&targetId=${FAKE_TARGET_ID}`,
        )) as any;
        expectTypedNonAuthz(batch);
      }),
    );
  });

  describe("Revisions", () => {
    test.provider(
      "register + get + list + batch-get against the bound application",
      (_stack) =>
        Effect.gen(function* () {
          // Registering an S3 revision records metadata only — the bundle
          // is not fetched until deployment, so this succeeds.
          const registered = (yield* post(
            `${baseUrl}/revision/register`,
          )) as any;
          expectAuthorized(registered);

          const got = (yield* getJson(`${baseUrl}/revision/get`)) as any;
          expectAuthorized(got);

          const listed = (yield* getJson(`${baseUrl}/revision/list`)) as any;
          expect(listed.errorTag).toBeUndefined();

          const batch = (yield* getJson(
            `${baseUrl}/revision/batch-get`,
          )) as any;
          expectAuthorized(batch);
        }),
    );
  });
});
