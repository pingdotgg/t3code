import * as CodeDeploy from "@/AWS/CodeDeploy";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export const FIXTURE_APPLICATION_NAME = "alchemy-test-codedeploy-bindings-app";
export const FIXTURE_GROUP_NAME = "alchemy-test-codedeploy-bindings-dg";

/** A syntactically valid but nonexistent revision to address revision ops. */
const FIXTURE_REVISION = {
  revisionType: "S3",
  s3Location: {
    bucket: "alchemy-test-codedeploy-bindings-nonexistent",
    key: "app.zip",
    bundleType: "zip",
  },
} as const;

export class CodeDeployTestFunction extends Lambda.Function<Lambda.Function>()(
  "CodeDeployTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts the tag is a typed,
 * non-authorization tag, which proves both the binding wiring and the IAM
 * grant. An untyped error crashes into a 500 instead.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

export default CodeDeployTestFunction.make(
  {
    main,
    url: true,
    // Deployment ops fan out SDK calls — AWS's 3s default intermittently
    // times out under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const role = yield* IAM.Role("CodeDeployBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "codedeploy.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda",
      ],
    });

    const app = yield* CodeDeploy.Application("BindingsApp", {
      applicationName: FIXTURE_APPLICATION_NAME,
      computePlatform: "Lambda",
    });

    const group = yield* CodeDeploy.DeploymentGroup("BindingsGroup", {
      applicationName: app.applicationName,
      deploymentGroupName: FIXTURE_GROUP_NAME,
      serviceRoleArn: role.roleArn,
      deploymentConfigName: "CodeDeployDefault.LambdaAllAtOnce",
      deploymentStyle: {
        deploymentType: "BLUE_GREEN",
        deploymentOption: "WITH_TRAFFIC_CONTROL",
      },
    });

    // Deployment plane
    const createDeployment = yield* CodeDeploy.CreateDeployment(group);
    const getDeployment = yield* CodeDeploy.GetDeployment(group);
    const batchGetDeployments = yield* CodeDeploy.BatchGetDeployments(group);
    const listDeployments = yield* CodeDeploy.ListDeployments(group);
    const stopDeployment = yield* CodeDeploy.StopDeployment(group);
    const continueDeployment = yield* CodeDeploy.ContinueDeployment(group);
    const putHookStatus =
      yield* CodeDeploy.PutLifecycleEventHookExecutionStatus(group);
    // Target plane
    const getDeploymentTarget = yield* CodeDeploy.GetDeploymentTarget(group);
    const listDeploymentTargets =
      yield* CodeDeploy.ListDeploymentTargets(group);
    const batchGetDeploymentTargets =
      yield* CodeDeploy.BatchGetDeploymentTargets(group);
    // Revision plane
    const registerApplicationRevision =
      yield* CodeDeploy.RegisterApplicationRevision(app);
    const getApplicationRevision =
      yield* CodeDeploy.GetApplicationRevision(app);
    const listApplicationRevisions =
      yield* CodeDeploy.ListApplicationRevisions(app);
    const batchGetApplicationRevisions =
      yield* CodeDeploy.BatchGetApplicationRevisions(app);

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.codedeploy) targeting this Function. Runtime firing rides on real
    // deployments; the test verifies the rule deploys.
    yield* CodeDeploy.consumeDeploymentEvents(
      { kinds: ["deployment"], applications: [FIXTURE_APPLICATION_NAME] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `codedeploy event: ${event.detail.deploymentId} -> ${event.detail.state}`,
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
          // ---- deployment plane ----
          case "POST /deployment/create": {
            // No revision on purpose — CodeDeploy must answer with the
            // TYPED RevisionRequiredException, which proves the binding
            // wiring, the name injection, and the IAM grant.
            const result = yield* errorTagged(createDeployment());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { deploymentId: result.deploymentId },
            );
          }
          case "GET /deployment/get": {
            const result = yield* errorTagged(
              getDeployment({ deploymentId: param("id") }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { status: result.deploymentInfo?.status },
            );
          }
          case "GET /deployment/batch-get": {
            const result = yield* errorTagged(
              batchGetDeployments({ deploymentIds: [param("id")] }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.deploymentsInfo ?? []).length },
            );
          }
          case "GET /deployment/list": {
            const result = yield* errorTagged(listDeployments());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { deployments: result.deployments ?? [] },
            );
          }
          case "POST /deployment/stop": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(
              stopDeployment({ deploymentId: body.id }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { status: result.status },
            );
          }
          case "POST /deployment/continue": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(
              continueDeployment({ deploymentId: body.id }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "POST /hook/status": {
            const body = (yield* request.json) as unknown as {
              deploymentId: string;
              executionId: string;
            };
            const result = yield* errorTagged(
              putHookStatus({
                deploymentId: body.deploymentId,
                lifecycleEventHookExecutionId: body.executionId,
                status: "Succeeded",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          // ---- target plane ----
          case "GET /target/get": {
            const result = yield* errorTagged(
              getDeploymentTarget({
                deploymentId: param("deploymentId"),
                targetId: param("targetId"),
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { status: result.deploymentTarget?.lambdaTarget?.status },
            );
          }
          case "GET /target/list": {
            const result = yield* errorTagged(
              listDeploymentTargets({ deploymentId: param("deploymentId") }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { targetIds: result.targetIds ?? [] },
            );
          }
          case "GET /target/batch-get": {
            const result = yield* errorTagged(
              batchGetDeploymentTargets({
                deploymentId: param("deploymentId"),
                targetIds: [param("targetId")],
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.deploymentTargets ?? []).length },
            );
          }

          // ---- revision plane ----
          case "POST /revision/register": {
            const result = yield* errorTagged(
              registerApplicationRevision({
                revision: FIXTURE_REVISION,
                description: "alchemy CodeDeploy bindings fixture revision",
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "GET /revision/get": {
            const result = yield* errorTagged(
              getApplicationRevision({ revision: FIXTURE_REVISION }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    description: result.revisionInfo?.description,
                  },
            );
          }
          case "GET /revision/list": {
            const result = yield* errorTagged(listApplicationRevisions());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.revisions ?? []).length },
            );
          }
          case "GET /revision/batch-get": {
            const result = yield* errorTagged(
              batchGetApplicationRevisions({
                revisions: [FIXTURE_REVISION],
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.revisions ?? []).length },
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
        CodeDeploy.CreateDeploymentHttp,
        CodeDeploy.GetDeploymentHttp,
        CodeDeploy.BatchGetDeploymentsHttp,
        CodeDeploy.ListDeploymentsHttp,
        CodeDeploy.StopDeploymentHttp,
        CodeDeploy.ContinueDeploymentHttp,
        CodeDeploy.PutLifecycleEventHookExecutionStatusHttp,
        CodeDeploy.GetDeploymentTargetHttp,
        CodeDeploy.ListDeploymentTargetsHttp,
        CodeDeploy.BatchGetDeploymentTargetsHttp,
        CodeDeploy.RegisterApplicationRevisionHttp,
        CodeDeploy.GetApplicationRevisionHttp,
        CodeDeploy.ListApplicationRevisionsHttp,
        CodeDeploy.BatchGetApplicationRevisionsHttp,
      ),
    ),
  ),
);
