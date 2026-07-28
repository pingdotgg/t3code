import * as CloudFormation from "@/AWS/CloudFormation";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/** Deterministic, account-unique export name for the fixture stack. */
export const FIXTURE_EXPORT_NAME = "AlchemyCfnBindingsExport";

// A tiny, free template: one SSM String parameter, one exported output.
const template = JSON.stringify({
  Resources: {
    Param: {
      Type: "AWS::SSM::Parameter",
      Properties: { Type: "String", Value: "cfn-bindings-fixture" },
    },
  },
  Outputs: {
    ParamName: {
      Value: { Ref: "Param" },
      Export: { Name: FIXTURE_EXPORT_NAME },
    },
  },
});

/**
 * Probe helper: run the bound operation and report either the success
 * projection or the typed error tag, so the test can assert that operations
 * rejected by CloudFormation fail with a TYPED tag (never an untyped
 * catch-all).
 */
const tagOr = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  onSuccess: (value: A) => Record<string, unknown>,
) =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      Result.isSuccess(result)
        ? onSuccess(result.success)
        : { errorTag: result.failure._tag },
    ),
  );

export class CfnTestFunction extends Lambda.Function<Lambda.Function>()(
  "CfnTestFunction",
) {}

export default CfnTestFunction.make(
  {
    main,
    url: true,
    // Above the 3s AWS default: describe/list calls plus distilled's bounded
    // retries must complete within the invocation.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const stack = yield* CloudFormation.Stack("BindingsStack", {
      templateBody: template,
    });

    const describeStacks = yield* CloudFormation.DescribeStacks(stack);
    const describeStackEvents =
      yield* CloudFormation.DescribeStackEvents(stack);
    const describeStackResources =
      yield* CloudFormation.DescribeStackResources(stack);
    const listStackResources = yield* CloudFormation.ListStackResources(stack);
    const getTemplate = yield* CloudFormation.GetTemplate(stack);
    const detectStackDrift = yield* CloudFormation.DetectStackDrift(stack);
    const describeStackResourceDrifts =
      yield* CloudFormation.DescribeStackResourceDrifts(stack);
    const signalResource = yield* CloudFormation.SignalResource(stack);
    const listExports = yield* CloudFormation.ListExports();
    const listImports = yield* CloudFormation.ListImports();
    const describeStackDriftDetectionStatus =
      yield* CloudFormation.DescribeStackDriftDetectionStatus();
    const validateTemplate = yield* CloudFormation.ValidateTemplate();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/describe") {
          const result = yield* describeStacks();
          const live = result.Stacks?.[0];
          return yield* HttpServerResponse.json({
            stackId: live?.StackId,
            status: live?.StackStatus,
            outputs: Object.fromEntries(
              (live?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]),
            ),
          });
        }

        if (request.method === "GET" && pathname === "/events") {
          const result = yield* describeStackEvents();
          return yield* HttpServerResponse.json({
            count: (result.StackEvents ?? []).length,
            statuses: (result.StackEvents ?? [])
              .slice(0, 5)
              .map((e) => e.ResourceStatus),
          });
        }

        if (request.method === "GET" && pathname === "/resources") {
          const result = yield* describeStackResources({
            LogicalResourceId: "Param",
          });
          const resource = result.StackResources?.[0];
          return yield* HttpServerResponse.json({
            logicalId: resource?.LogicalResourceId,
            physicalId: resource?.PhysicalResourceId,
            type: resource?.ResourceType,
          });
        }

        if (request.method === "GET" && pathname === "/list-resources") {
          const result = yield* listStackResources();
          return yield* HttpServerResponse.json({
            types: (result.StackResourceSummaries ?? []).map(
              (r) => r.ResourceType,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/template") {
          const result = yield* getTemplate();
          return yield* HttpServerResponse.json({
            template: result.TemplateBody,
          });
        }

        if (request.method === "POST" && pathname === "/drift") {
          const result = yield* detectStackDrift();
          return yield* HttpServerResponse.json({
            detectionId: result.StackDriftDetectionId,
          });
        }

        if (request.method === "GET" && pathname === "/drift-status") {
          const detectionId = url.searchParams.get("id") ?? undefined;
          const result = yield* describeStackDriftDetectionStatus({
            StackDriftDetectionId: detectionId,
          });
          return yield* HttpServerResponse.json({
            detectionStatus: result.DetectionStatus,
            stackDriftStatus: result.StackDriftStatus,
          });
        }

        if (request.method === "GET" && pathname === "/resource-drifts") {
          const result = yield* describeStackResourceDrifts();
          return yield* HttpServerResponse.json({
            drifts: (result.StackResourceDrifts ?? []).map((d) => ({
              logicalId: d.LogicalResourceId,
              status: d.StackResourceDriftStatus,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/exports") {
          const result = yield* listExports();
          return yield* HttpServerResponse.json({
            names: (result.Exports ?? []).map((e) => e.Name),
          });
        }

        if (request.method === "GET" && pathname === "/imports") {
          const name = url.searchParams.get("name") ?? FIXTURE_EXPORT_NAME;
          // Nothing imports the fixture export — CloudFormation rejects the
          // call with a typed ValidationError, proving IAM + typed errors.
          return yield* HttpServerResponse.json(
            yield* tagOr(listImports({ ExportName: name }), (result) => ({
              imports: result.Imports ?? [],
            })),
          );
        }

        if (request.method === "POST" && pathname === "/validate") {
          const body = (yield* request.json) as unknown as {
            template?: string;
          };
          return yield* HttpServerResponse.json(
            yield* tagOr(
              validateTemplate({
                TemplateBody: body.template ?? template,
              }),
              (result) => ({
                parameters: (result.Parameters ?? []).map(
                  (p) => p.ParameterKey,
                ),
                capabilities: result.Capabilities ?? [],
              }),
            ),
          );
        }

        if (request.method === "POST" && pathname === "/signal") {
          // CloudFormation accepts (and ignores) signals for resources that
          // are not waiting on a CreationPolicy — success proves the IAM +
          // binding wiring; a rejection would surface as a typed tag.
          return yield* HttpServerResponse.json(
            yield* tagOr(
              signalResource({
                LogicalResourceId: "Param",
                UniqueId: "cfn-bindings-test",
                Status: "SUCCESS",
              }),
              () => ({ ok: true }),
            ),
          );
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
        CloudFormation.DescribeStacksHttp,
        CloudFormation.DescribeStackEventsHttp,
        CloudFormation.DescribeStackResourcesHttp,
        CloudFormation.ListStackResourcesHttp,
        CloudFormation.GetTemplateHttp,
        CloudFormation.DetectStackDriftHttp,
        CloudFormation.DescribeStackResourceDriftsHttp,
        CloudFormation.SignalResourceHttp,
        CloudFormation.ListExportsHttp,
        CloudFormation.ListImportsHttp,
        CloudFormation.DescribeStackDriftDetectionStatusHttp,
        CloudFormation.ValidateTemplateHttp,
      ),
    ),
  ),
);
