import * as CodePipeline from "@/AWS/CodePipeline";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "@/Output";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export const FIXTURE_PIPELINE_NAME = "alchemy-test-codepipeline-bindings";
export const SOURCE_OBJECT_KEY = "source.zip";
export const SOURCE_STAGE = "Source";
export const SOURCE_ACTION = "S3Source";
export const APPROVAL_STAGE = "Approve";
export const APPROVAL_ACTION = "ManualApproval";

/** A minimal valid (empty) zip archive: the end-of-central-directory record. */
const EMPTY_ZIP = new Uint8Array([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

export class CodePipelineTestFunction extends Lambda.Function<Lambda.Function>()(
  "CodePipelineTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts the tag is a typed,
 * non-authorization tag, which proves both the binding wiring and the IAM
 * grant. An untyped error crashes into a 500 instead.
 */
const errorTagged = <A, E extends { _tag: string; message?: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string; errorMessage?: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string; errorMessage?: string } => a),
    Effect.catch((e) =>
      Effect.succeed({ errorTag: e._tag, errorMessage: e.message }),
    ),
  );

export default CodePipelineTestFunction.make(
  {
    main,
    url: true,
    // Pipeline state reads fan out SDK calls — AWS's 3s default
    // intermittently times out under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const source = yield* S3.Bucket("PipelineBindingsSource", {
      versioning: "Enabled",
      forceDestroy: true,
    });
    const artifacts = yield* S3.Bucket("PipelineBindingsArtifacts", {
      forceDestroy: true,
    });

    const role = yield* IAM.Role("PipelineBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "codepipeline.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        Artifacts: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "s3:GetObject",
                "s3:GetObjectVersion",
                "s3:PutObject",
                "s3:GetBucketVersioning",
                "s3:ListBucket",
              ],
              Resource: [
                source.bucketArn,
                Output.interpolate`${source.bucketArn}/*` as any,
                artifacts.bucketArn,
                Output.interpolate`${artifacts.bucketArn}/*` as any,
              ],
            },
          ],
        },
      },
    });

    const pipeline = yield* CodePipeline.Pipeline("BindingsPipeline", {
      pipelineName: FIXTURE_PIPELINE_NAME,
      roleArn: role.roleArn,
      artifactStore: { type: "S3", location: artifacts.bucketName },
      stages: [
        {
          name: SOURCE_STAGE,
          actions: [
            {
              name: SOURCE_ACTION,
              category: "Source",
              owner: "AWS",
              provider: "S3",
              outputArtifacts: ["SourceOutput"],
              configuration: {
                S3Bucket: source.bucketName,
                S3ObjectKey: SOURCE_OBJECT_KEY,
                PollForSourceChanges: "false",
              },
            },
          ],
        },
        {
          name: APPROVAL_STAGE,
          actions: [
            {
              name: APPROVAL_ACTION,
              category: "Approval",
              owner: "AWS",
              provider: "Manual",
            },
          ],
        },
      ],
    });

    // Source plane (cross-service: seed the source object from the Lambda).
    const putObject = yield* S3.PutObject(source);
    // Execution plane
    const startExecution = yield* CodePipeline.StartPipelineExecution(pipeline);
    const stopExecution = yield* CodePipeline.StopPipelineExecution(pipeline);
    const getState = yield* CodePipeline.GetPipelineState(pipeline);
    const getExecution = yield* CodePipeline.GetPipelineExecution(pipeline);
    const listExecutions = yield* CodePipeline.ListPipelineExecutions(pipeline);
    const listActions = yield* CodePipeline.ListActionExecutions(pipeline);
    const listRules = yield* CodePipeline.ListRuleExecutions(pipeline);
    const listDeployTargets =
      yield* CodePipeline.ListDeployActionExecutionTargets(pipeline);
    // Stage plane
    const retryStage = yield* CodePipeline.RetryStageExecution(pipeline);
    const rollbackStage = yield* CodePipeline.RollbackStage(pipeline);
    const enableTransition =
      yield* CodePipeline.EnableStageTransition(pipeline);
    const disableTransition =
      yield* CodePipeline.DisableStageTransition(pipeline);
    const overrideCondition =
      yield* CodePipeline.OverrideStageCondition(pipeline);
    // Approval + source-revision plane
    const putApproval = yield* CodePipeline.PutApprovalResult(pipeline);
    const putActionRevision = yield* CodePipeline.PutActionRevision(pipeline);
    // Job-worker plane (account-scoped — no resource anchor)
    const getJobDetails = yield* CodePipeline.GetJobDetails();
    const putJobSuccess = yield* CodePipeline.PutJobSuccessResult();
    const putJobFailure = yield* CodePipeline.PutJobFailureResult();
    const pollForJobs = yield* CodePipeline.PollForJobs();
    const acknowledgeJob = yield* CodePipeline.AcknowledgeJob();

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.codepipeline) targeting this Function. Runtime firing rides on the
    // real executions the suite starts; the test verifies the rule deploys.
    yield* CodePipeline.consumePipelineEvents(
      { kinds: ["execution"], pipelineNames: [FIXTURE_PIPELINE_NAME] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `codepipeline event: ${event.detail.pipeline} -> ${event.detail.state}`,
          ),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const route = `${request.method} ${pathname}`;
        const param = (name: string) => url.searchParams.get(name)!;

        switch (route) {
          // ---- source plane ----
          case "POST /source/upload": {
            const result = yield* errorTagged(
              putObject({ Key: SOURCE_OBJECT_KEY, Body: EMPTY_ZIP }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { versionId: result.VersionId },
            );
          }

          // ---- execution plane ----
          case "POST /execution/start": {
            const result = yield* errorTagged(startExecution());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { executionId: result.pipelineExecutionId },
            );
          }
          case "POST /execution/stop": {
            const body = (yield* request.json) as unknown as {
              id: string;
              abandon?: boolean;
            };
            const result = yield* errorTagged(
              stopExecution({
                pipelineExecutionId: body.id,
                abandon: body.abandon,
                reason: "stopped by bindings test",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { executionId: result.pipelineExecutionId },
            );
          }
          case "GET /state": {
            const result = yield* errorTagged(getState());
            if ("errorTag" in result) {
              return yield* HttpServerResponse.json(result);
            }
            const approvalState = result.stageStates
              ?.find((s) => s.stageName === APPROVAL_STAGE)
              ?.actionStates?.find((a) => a.actionName === APPROVAL_ACTION);
            const approveStage = result.stageStates?.find(
              (s) => s.stageName === APPROVAL_STAGE,
            );
            return yield* HttpServerResponse.json({
              pipelineName: result.pipelineName,
              stageNames: (result.stageStates ?? []).map((s) => s.stageName),
              approvalToken: approvalState?.latestExecution?.token,
              approvalStatus: approvalState?.latestExecution?.status,
              inboundTransitionEnabled:
                approveStage?.inboundTransitionState?.enabled,
            });
          }
          case "GET /execution/get": {
            const result = yield* errorTagged(
              getExecution({ pipelineExecutionId: param("id") }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { status: result.pipelineExecution?.status },
            );
          }
          case "GET /executions": {
            const result = yield* errorTagged(listExecutions());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    ids: (result.pipelineExecutionSummaries ?? []).map(
                      (e) => e.pipelineExecutionId,
                    ),
                  },
            );
          }
          case "GET /actions": {
            const executionId = url.searchParams.get("executionId");
            const result = yield* errorTagged(
              listActions(
                executionId !== null
                  ? { filter: { pipelineExecutionId: executionId } }
                  : undefined,
              ),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    actions: (result.actionExecutionDetails ?? []).map(
                      (a) => a.actionName,
                    ),
                  },
            );
          }
          case "GET /rules": {
            const result = yield* errorTagged(listRules());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.ruleExecutionDetails ?? []).length },
            );
          }
          case "GET /deploy-targets": {
            const result = yield* errorTagged(
              listDeployTargets({
                actionExecutionId: param("actionExecutionId"),
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.targets ?? []).length },
            );
          }

          // ---- stage plane ----
          case "POST /stage/retry": {
            const body = (yield* request.json) as unknown as {
              stageName: string;
              executionId: string;
            };
            const result = yield* errorTagged(
              retryStage({
                stageName: body.stageName,
                pipelineExecutionId: body.executionId,
                retryMode: "FAILED_ACTIONS",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { executionId: result.pipelineExecutionId },
            );
          }
          case "POST /stage/rollback": {
            const body = (yield* request.json) as unknown as {
              stageName: string;
              targetExecutionId: string;
            };
            const result = yield* errorTagged(
              rollbackStage({
                stageName: body.stageName,
                targetPipelineExecutionId: body.targetExecutionId,
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { executionId: result.pipelineExecutionId },
            );
          }
          case "POST /transition/disable": {
            const body = (yield* request.json) as unknown as {
              stageName: string;
            };
            const result = yield* errorTagged(
              disableTransition({
                stageName: body.stageName,
                transitionType: "Inbound",
                reason: "bindings test freeze",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "POST /transition/enable": {
            const body = (yield* request.json) as unknown as {
              stageName: string;
            };
            const result = yield* errorTagged(
              enableTransition({
                stageName: body.stageName,
                transitionType: "Inbound",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "POST /condition/override": {
            const body = (yield* request.json) as unknown as {
              stageName: string;
              executionId: string;
            };
            const result = yield* errorTagged(
              overrideCondition({
                stageName: body.stageName,
                pipelineExecutionId: body.executionId,
                conditionType: "BEFORE_ENTRY",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          // ---- approval + source-revision plane ----
          case "POST /approval": {
            const body = (yield* request.json) as unknown as {
              token: string;
              status: "Approved" | "Rejected";
            };
            const result = yield* errorTagged(
              putApproval({
                stageName: APPROVAL_STAGE,
                actionName: APPROVAL_ACTION,
                token: body.token,
                result: {
                  status: body.status,
                  summary: "answered by bindings test",
                },
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { approvedAt: result.approvedAt },
            );
          }
          case "POST /action/revision": {
            const body = (yield* request.json) as unknown as {
              actionName: string;
              revisionId: string;
            };
            const result = yield* errorTagged(
              putActionRevision({
                stageName: SOURCE_STAGE,
                actionName: body.actionName,
                actionRevision: {
                  revisionId: body.revisionId,
                  revisionChangeId: body.revisionId,
                  created: new Date(),
                },
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    newRevision: result.newRevision,
                    executionId: result.pipelineExecutionId,
                  },
            );
          }

          // ---- job-worker plane ----
          case "GET /job/get": {
            const result = yield* errorTagged(
              getJobDetails({ jobId: param("id") }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { jobId: result.jobDetails?.id },
            );
          }
          case "POST /job/success": {
            const body = (yield* request.json) as unknown as {
              jobId: string;
            };
            const result = yield* errorTagged(
              putJobSuccess({ jobId: body.jobId }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "POST /job/failure": {
            const body = (yield* request.json) as unknown as {
              jobId: string;
            };
            const result = yield* errorTagged(
              putJobFailure({
                jobId: body.jobId,
                failureDetails: {
                  type: "JobFailed",
                  message: "failed by bindings test",
                },
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          case "POST /job/poll": {
            // The fixture declares no custom action type — a typed
            // ActionTypeNotFoundException proves wiring + grant.
            const result = yield* errorTagged(
              pollForJobs({
                actionTypeId: {
                  category: "Build",
                  owner: "Custom",
                  provider: "AlchemyBindingsTest",
                  version: "1",
                },
                maxBatchSize: 1,
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.jobs ?? []).length },
            );
          }
          case "POST /job/ack": {
            const body = (yield* request.json) as unknown as {
              jobId: string;
              nonce: string;
            };
            const result = yield* errorTagged(
              acknowledgeJob({ jobId: body.jobId, nonce: body.nonce }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { status: result.status },
            );
          }

          default:
            return yield* HttpServerResponse.json(
              { error: "Not found", route },
              { status: 404 },
            );
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        S3.PutObjectHttp,
        CodePipeline.StartPipelineExecutionHttp,
        CodePipeline.StopPipelineExecutionHttp,
        CodePipeline.GetPipelineStateHttp,
        CodePipeline.GetPipelineExecutionHttp,
        CodePipeline.ListPipelineExecutionsHttp,
        CodePipeline.ListActionExecutionsHttp,
        CodePipeline.ListRuleExecutionsHttp,
        CodePipeline.ListDeployActionExecutionTargetsHttp,
        CodePipeline.RetryStageExecutionHttp,
        CodePipeline.RollbackStageHttp,
        CodePipeline.EnableStageTransitionHttp,
        CodePipeline.DisableStageTransitionHttp,
        CodePipeline.OverrideStageConditionHttp,
        CodePipeline.PutApprovalResultHttp,
        CodePipeline.PutActionRevisionHttp,
        CodePipeline.GetJobDetailsHttp,
        CodePipeline.PutJobSuccessResultHttp,
        CodePipeline.PutJobFailureResultHttp,
        CodePipeline.PollForJobsHttp,
        CodePipeline.AcknowledgeJobHttp,
      ),
    ),
  ),
);
