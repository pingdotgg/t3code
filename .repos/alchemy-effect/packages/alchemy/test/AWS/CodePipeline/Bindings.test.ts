import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CodePipelineTestFunctionLive, {
  APPROVAL_STAGE,
  CodePipelineTestFunction,
  SOURCE_ACTION,
  SOURCE_STAGE,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CodePipelineBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load — and the freshly
// attached codepipeline policy has been observed to take >150s to propagate
// on a first-ever deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(90),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the shared Lambda fixture (cold re-init, IAM
// propagation on the freshly attached codepipeline policy surfaced as a 500
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

class ApprovalNotPending extends Data.TaggedError("ApprovalNotPending") {}

class ExecutionNotVisible extends Data.TaggedError("ExecutionNotVisible") {}

/**
 * A freshly started execution is not immediately visible to
 * GetPipelineExecution / ListPipelineExecutions (eventual consistency) —
 * poll the route (bounded) until it stops answering not-found/absent.
 */
const untilExecutionVisible = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  visible: (body: A) => boolean,
): Effect.Effect<A, E | ExecutionNotVisible, R> =>
  effect.pipe(
    Effect.flatMap((body) =>
      visible(body)
        ? Effect.succeed(body)
        : Effect.fail(new ExecutionNotVisible()),
    ),
    Effect.retry({
      while: (e): boolean => e instanceof ExecutionNotVisible,
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

describe.sequential("CodePipeline Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("CodePipeline test setup: destroying previous");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CodePipeline test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CodePipelineTestFunction;
        }).pipe(Effect.provide(CodePipelineTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/state`;

      yield* Effect.logInfo(
        `CodePipeline test setup: probing readiness at ${readinessUrl}`,
      );
      // Ready = the function answers 200 AND the freshly attached
      // codepipeline policy has propagated (an AccessDeniedException errorTag
      // means IAM is still converging — keep probing).
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body: any) =>
          body.errorTag === undefined
            ? Effect.succeed(body)
            : Effect.fail(
                new Error(
                  `IAM not propagated: ${body.errorTag}: ${body.errorMessage}`,
                ),
              ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 240_000,
  });

  describe("GetPipelineState + ListPipelineExecutions + ListActionExecutions + ListRuleExecutions", () => {
    test.provider("reads the pipeline's state and histories", (_stack) =>
      Effect.gen(function* () {
        const state = (yield* getJson(`${baseUrl}/state`)) as any;
        expect(state.errorTag).toBeUndefined();
        expect(state.stageNames).toEqual([SOURCE_STAGE, APPROVAL_STAGE]);

        const executions = (yield* getJson(`${baseUrl}/executions`)) as any;
        expect(executions.errorTag).toBeUndefined();
        expect(Array.isArray(executions.ids)).toBe(true);

        const actions = (yield* getJson(`${baseUrl}/actions`)) as any;
        expect(actions.errorTag).toBeUndefined();

        const rules = (yield* getJson(`${baseUrl}/rules`)) as any;
        expectAuthorized(rules);
      }),
    );
  });

  describe("StartPipelineExecution + GetPipelineExecution + PutApprovalResult + StopPipelineExecution", () => {
    test.provider(
      "runs an execution to the manual gate and approves it",
      (_stack) =>
        Effect.gen(function* () {
          // Seed the source object (S3.PutObject binding on the Lambda).
          const uploaded = (yield* post(`${baseUrl}/source/upload`)) as any;
          expect(uploaded.errorTag).toBeUndefined();

          // Start an execution.
          const started = (yield* post(`${baseUrl}/execution/start`)) as any;
          expect(started.errorTag).toBeUndefined();
          const executionId = started.executionId as string;
          expect(executionId).toBeTruthy();

          // GetPipelineExecution sees it (eventual consistency — poll).
          const got = (yield* untilExecutionVisible(
            getJson(
              `${baseUrl}/execution/get?id=${encodeURIComponent(executionId)}`,
            ),
            (body: any) =>
              body.errorTag !== "PipelineExecutionNotFoundException",
          )) as any;
          expect(got.errorTag).toBeUndefined();
          expect(got.status).toBeTruthy();

          // ListPipelineExecutions includes it (eventual consistency — poll).
          const listed = (yield* untilExecutionVisible(
            getJson(`${baseUrl}/executions`),
            (body: any) => (body.ids ?? []).includes(executionId),
          )) as any;
          expect(listed.ids).toContain(executionId);

          // Wait (bounded) for the source stage to hand the execution to the
          // manual-approval action, which exposes an approval token.
          const token = yield* getJson(`${baseUrl}/state`).pipe(
            Effect.flatMap((state: any) =>
              typeof state.approvalToken === "string"
                ? Effect.succeed(state.approvalToken as string)
                : Effect.fail(new ApprovalNotPending()),
            ),
            Effect.retry({
              while: (e): boolean => e._tag === "ApprovalNotPending",
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );

          // ListActionExecutions shows the source action ran for this
          // execution.
          const actions = (yield* getJson(
            `${baseUrl}/actions?executionId=${encodeURIComponent(executionId)}`,
          )) as any;
          expect(actions.errorTag).toBeUndefined();
          expect(actions.actions).toContain(SOURCE_ACTION);

          // Answer the approval.
          const approved = (yield* postJson(`${baseUrl}/approval`, {
            token,
            status: "Approved",
          })) as any;
          expectAuthorized(approved);

          // StopPipelineExecution — the execution just completed via the
          // approval, so a typed not-stoppable rejection is the expected
          // proof of wiring (success is also fine if timing races).
          const stopped = (yield* postJson(`${baseUrl}/execution/stop`, {
            id: executionId,
            abandon: true,
          })) as any;
          expectAuthorized(stopped);
        }),
      { timeout: 240_000 },
    );
  });

  describe("DisableStageTransition + EnableStageTransition", () => {
    test.provider("freezes and re-opens the approval stage", (_stack) =>
      Effect.gen(function* () {
        const disabled = (yield* postJson(`${baseUrl}/transition/disable`, {
          stageName: APPROVAL_STAGE,
        })) as any;
        expect(disabled.errorTag).toBeUndefined();

        // GetPipelineState reflects the transition change eventually — poll
        // (bounded) until the disabled transition is observed.
        const frozen = (yield* untilExecutionVisible(
          getJson(`${baseUrl}/state`),
          (body: any) => body.inboundTransitionEnabled === false,
        )) as any;
        expect(frozen.inboundTransitionEnabled).toBe(false);

        const enabled = (yield* postJson(`${baseUrl}/transition/enable`, {
          stageName: APPROVAL_STAGE,
        })) as any;
        expect(enabled.errorTag).toBeUndefined();

        const open = (yield* untilExecutionVisible(
          getJson(`${baseUrl}/state`),
          (body: any) => body.inboundTransitionEnabled === true,
        )) as any;
        expect(open.inboundTransitionEnabled).toBe(true);
      }),
    );
  });

  describe("RetryStageExecution + RollbackStage + OverrideStageCondition + PutActionRevision + ListDeployActionExecutionTargets", () => {
    test.provider(
      "stage operations answer typed for invalid targets",
      (_stack) =>
        Effect.gen(function* () {
          // Nothing failed — retrying is a typed StageNotRetryable /
          // Conflict / NotLatestPipelineExecution rejection.
          const retried = (yield* postJson(`${baseUrl}/stage/retry`, {
            stageName: APPROVAL_STAGE,
            executionId: FAKE_UUID,
          })) as any;
          expectTypedNonAuthz(retried);

          const rolledBack = (yield* postJson(`${baseUrl}/stage/rollback`, {
            stageName: APPROVAL_STAGE,
            targetExecutionId: FAKE_UUID,
          })) as any;
          expectTypedNonAuthz(rolledBack);

          // The fixture pipeline declares no stage conditions.
          const overridden = (yield* postJson(`${baseUrl}/condition/override`, {
            stageName: APPROVAL_STAGE,
            executionId: FAKE_UUID,
          })) as any;
          expectTypedNonAuthz(overridden);

          // Unknown action name — typed ActionNotFoundException.
          const revision = (yield* postJson(`${baseUrl}/action/revision`, {
            actionName: "NoSuchAction",
            revisionId: FAKE_UUID,
          })) as any;
          expectTypedNonAuthz(revision);

          // No deploy actions in the fixture — success-empty or a typed
          // rejection both prove the wiring.
          const targets = (yield* getJson(
            `${baseUrl}/deploy-targets?actionExecutionId=${FAKE_UUID}`,
          )) as any;
          expectAuthorized(targets);

          // Approval with a fake token — typed InvalidApprovalToken /
          // ApprovalAlreadyCompleted rejection.
          const approval = (yield* postJson(`${baseUrl}/approval`, {
            token: FAKE_UUID,
            status: "Rejected",
          })) as any;
          expectTypedNonAuthz(approval);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetJobDetails + PutJobSuccessResult + PutJobFailureResult + PollForJobs + AcknowledgeJob", () => {
    test.provider(
      "job-worker bindings answer typed for unknown jobs",
      (_stack) =>
        Effect.gen(function* () {
          const details = (yield* getJson(
            `${baseUrl}/job/get?id=${FAKE_UUID}`,
          )) as any;
          expectAuthorized(details);

          const success = (yield* postJson(`${baseUrl}/job/success`, {
            jobId: FAKE_UUID,
          })) as any;
          expectTypedNonAuthz(success);

          const failure = (yield* postJson(`${baseUrl}/job/failure`, {
            jobId: FAKE_UUID,
          })) as any;
          expectTypedNonAuthz(failure);

          // No custom action type exists — typed ActionTypeNotFoundException.
          const polled = (yield* post(`${baseUrl}/job/poll`)) as any;
          expectTypedNonAuthz(polled);

          // Unknown job/nonce — typed JobNotFound / InvalidNonce rejection.
          const acked = (yield* postJson(`${baseUrl}/job/ack`, {
            jobId: FAKE_UUID,
            nonce: FAKE_UUID,
          })) as any;
          expectTypedNonAuthz(acked);
        }),
    );
  });
});
