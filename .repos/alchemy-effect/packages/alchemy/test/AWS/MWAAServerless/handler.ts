import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as MWAAServerless from "@/AWS/MWAAServerless";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// A well-formed-but-nonexistent run id. Probes must answer with a typed
// service error (ResourceNotFoundException or ValidationException), which
// proves the IAM grant passed authorization AND the workflow ARN was
// injected from the binding.
const FAKE_RUN_ID = "00000000-0000-4000-8000-000000000000";

/** Deterministic names shared with the test for out-of-band verification. */
export const BINDINGS_WORKFLOW_NAME = "alchemy-test-mwaas-bind";
export const BINDINGS_ROLE_NAME = "alchemy-test-mwaas-bind-role";
// S3 bucket names are globally unique — keep a stable random-ish suffix.
export const BINDINGS_BUCKET_NAME = "alchemy-test-mwaas-bind-defs-8k2f";
export const DEFINITION_KEY = "workflows/bindings.yaml";

/**
 * The checked-in workflow definition the test uploads to S3 before the
 * fixture deploys: a single S3ListOperator task listing the definitions
 * bucket, schedule `null` so runs are on-demand only.
 */
export const WORKFLOW_DEFINITION = [
  "alchemy-mwaa-serverless-bindings-test:",
  "  default_args:",
  "    owner: alchemy",
  "  schedule: null",
  "  tasks:",
  "    list_definitions:",
  "      operator: airflow.providers.amazon.aws.operators.s3.S3ListOperator",
  `      bucket: ${BINDINGS_BUCKET_NAME}`,
  "      prefix: workflows/",
  "",
].join("\n");

export class MwaaServerlessTestFunction extends Lambda.Function<Lambda.Function>()(
  "MwaaServerlessTestFunction",
) {}

export default MwaaServerlessTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The execution role the workflow's tasks assume — read access to the
    // definitions bucket so the single S3ListOperator task can succeed.
    const role = yield* IAM.Role("WorkflowRole", {
      roleName: BINDINGS_ROLE_NAME,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "airflow-serverless.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        definitions: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject*", "s3:GetBucket*", "s3:List*"],
              Resource: [
                `arn:aws:s3:::${BINDINGS_BUCKET_NAME}`,
                `arn:aws:s3:::${BINDINGS_BUCKET_NAME}/*`,
              ],
            },
          ],
        },
      },
    });

    // The workflow the bindings are bound to. The definition object is
    // uploaded out-of-band by the test BEFORE this fixture deploys.
    const workflow = yield* MWAAServerless.Workflow("BindingWorkflow", {
      name: BINDINGS_WORKFLOW_NAME,
      definitionS3Location: {
        bucket: BINDINGS_BUCKET_NAME,
        objectKey: DEFINITION_KEY,
      },
      roleArn: role.roleArn,
      description: "alchemy mwaa-serverless bindings fixture",
      tags: { purpose: "alchemy-test" },
    });

    // Event source: subscribe the host to workflow-run state changes. The
    // deploy proves the EventBridge rule + invoke permission.
    yield* MWAAServerless.consumeWorkflowRunEvents(
      { runStates: ["Succeeded", "Failed", "Stopped"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `mwaa-serverless run ${event.detail.runId} -> ${event["detail-type"]}`,
          ),
        ),
    );

    const startWorkflowRun = yield* MWAAServerless.StartWorkflowRun(workflow);
    const getWorkflowRun = yield* MWAAServerless.GetWorkflowRun(workflow);
    const stopWorkflowRun = yield* MWAAServerless.StopWorkflowRun(workflow);
    const listWorkflowRuns = yield* MWAAServerless.ListWorkflowRuns(workflow);
    const getTaskInstance = yield* MWAAServerless.GetTaskInstance(workflow);
    const listTaskInstances = yield* MWAAServerless.ListTaskInstances(workflow);
    const listWorkflowVersions =
      yield* MWAAServerless.ListWorkflowVersions(workflow);

    const bound = {
      startWorkflowRun,
      getWorkflowRun,
      stopWorkflowRun,
      listWorkflowRuns,
      getTaskInstance,
      listTaskInstances,
      listWorkflowVersions,
    };

    // Run an operation and answer with its typed outcome: `ok` on success,
    // the error's `_tag` otherwise. Probes assert the tag — a typed service
    // error (not AccessDeniedException) proves the IAM grant and the
    // injected workflow ARN both work.
    const probe = <A, E extends { _tag: string }>(
      effect: Effect.Effect<A, E>,
    ) =>
      effect.pipe(
        Effect.map(() => ({ tag: "ok", detail: "" }) as const),
        Effect.catch((error) =>
          Effect.succeed({ tag: error._tag, detail: String(error) } as const),
        ),
        Effect.flatMap((outcome) => HttpServerResponse.json(outcome)),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        // Real reads: workflow ARN injected from the binding.
        if (request.method === "GET" && pathname === "/runs") {
          const { WorkflowRuns } = yield* listWorkflowRuns().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            ids: (WorkflowRuns ?? []).map((run) => run.RunId),
          });
        }
        if (request.method === "GET" && pathname === "/versions") {
          const { WorkflowVersions } = yield* listWorkflowVersions().pipe(
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({
            versions: (WorkflowVersions ?? []).map((v) => v.WorkflowVersion),
          });
        }

        // Typed not-found probes on a nonexistent run.
        if (request.method === "GET" && pathname === "/run-fake") {
          return yield* probe(getWorkflowRun({ RunId: FAKE_RUN_ID }));
        }
        if (request.method === "GET" && pathname === "/tasks-fake") {
          return yield* probe(listTaskInstances({ RunId: FAKE_RUN_ID }));
        }
        if (request.method === "GET" && pathname === "/task-fake") {
          return yield* probe(
            getTaskInstance({
              RunId: FAKE_RUN_ID,
              TaskInstanceId: FAKE_RUN_ID,
            }),
          );
        }
        if (request.method === "POST" && pathname === "/run-stop-fake") {
          return yield* probe(stopWorkflowRun({ RunId: FAKE_RUN_ID }));
        }

        // Real run round trip: start an on-demand run; the test observes it
        // and stops it immediately after.
        if (request.method === "POST" && pathname === "/run-start") {
          const started = yield* startWorkflowRun().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            runId: started.RunId,
            status: started.Status,
          });
        }
        if (request.method === "GET" && pathname === "/run-detail") {
          const id = url.searchParams.get("id");
          if (!id) {
            return yield* HttpServerResponse.json(
              { error: "id query parameter required" },
              { status: 400 },
            );
          }
          const run = yield* getWorkflowRun({ RunId: id }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            runId: run.RunId,
            status: run.RunDetail?.RunState,
            runType: run.RunType,
          });
        }
        if (request.method === "POST" && pathname === "/run-stop") {
          const id = url.searchParams.get("id");
          if (!id) {
            return yield* HttpServerResponse.json(
              { error: "id query parameter required" },
              { status: 400 },
            );
          }
          return yield* probe(stopWorkflowRun({ RunId: id }));
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        MWAAServerless.StartWorkflowRunHttp,
        MWAAServerless.GetWorkflowRunHttp,
        MWAAServerless.StopWorkflowRunHttp,
        MWAAServerless.ListWorkflowRunsHttp,
        MWAAServerless.GetTaskInstanceHttp,
        MWAAServerless.ListTaskInstancesHttp,
        MWAAServerless.ListWorkflowVersionsHttp,
      ),
    ),
  ),
);
