import * as CloudControl from "@/AWS/CloudControl";
import * as Lambda from "@/AWS/Lambda";
import type * as cloudcontrol from "@distilled.cloud/aws/cloudcontrol";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const SSM_PARAMETER = "AWS::SSM::Parameter";

// Deterministic parameter names unique to this suite (distinct from
// Resource.test.ts's parameter).
export const FIXTURE_PARAM = "/alchemy-test/cloudcontrol/bindings/fixture";
export const RUNTIME_PARAM = "/alchemy-test/cloudcontrol/bindings/runtime";

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

const readValue = (
  description: cloudcontrol.ResourceDescription | undefined,
): string | undefined => {
  const raw = plain(description?.Properties);
  if (raw === undefined) return undefined;
  return (JSON.parse(raw) as { Value?: string }).Value;
};

export class CloudControlTestFunction extends Lambda.Function<Lambda.Function>()(
  "CloudControlTestFunction",
) {}

export default CloudControlTestFunction.make(
  {
    main,
    url: true,
    // The runtime lifecycle routes poll async Cloud Control operations.
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    // A Cloud Control-managed resource deployed with the stack, read back by
    // the GetResource / ListResources routes.
    yield* CloudControl.Resource("BindingsParam", {
      typeName: SSM_PARAMETER,
      desiredState: {
        Name: FIXTURE_PARAM,
        Type: "String",
        Value: "fixture",
      },
    });

    // Cloud Control invokes the AWS::SSM::Parameter handlers with the
    // caller's credentials, so the host also needs the handlers' underlying
    // SSM permissions (see the type schema's `handlers` section).
    const ssmHandlerPolicy = [
      {
        Effect: "Allow" as const,
        Action: [
          "ssm:PutParameter",
          "ssm:DeleteParameter",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:DescribeParameters",
          "ssm:AddTagsToResource",
          "ssm:RemoveTagsFromResource",
          "ssm:ListTagsForResource",
          "ssm:LabelParameterVersion",
          "ssm:UnlabelParameterVersion",
        ],
        Resource: ["*"],
      },
    ];

    const getResource = yield* CloudControl.GetResource({
      handlerPolicyStatements: ssmHandlerPolicy,
    });
    const listResources = yield* CloudControl.ListResources({
      handlerPolicyStatements: ssmHandlerPolicy,
    });
    const createResource = yield* CloudControl.CreateResource({
      handlerPolicyStatements: ssmHandlerPolicy,
    });
    const updateResource = yield* CloudControl.UpdateResource({
      handlerPolicyStatements: ssmHandlerPolicy,
    });
    const deleteResource = yield* CloudControl.DeleteResource({
      handlerPolicyStatements: ssmHandlerPolicy,
    });
    const getResourceRequestStatus =
      yield* CloudControl.GetResourceRequestStatus();
    const listResourceRequests = yield* CloudControl.ListResourceRequests();
    const cancelResourceRequest = yield* CloudControl.CancelResourceRequest();

    const bound = {
      getResource,
      listResources,
      createResource,
      updateResource,
      deleteResource,
      getResourceRequestStatus,
      listResourceRequests,
      cancelResourceRequest,
    };

    /** Poll a request token until the operation settles (bounded ~80s). */
    const waitSettled = Effect.fn(function* (requestToken: string) {
      return yield* getResourceRequestStatus({
        RequestToken: requestToken,
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r): boolean => {
            const status = r.ProgressEvent?.OperationStatus;
            return (
              status !== "PENDING" &&
              status !== "IN_PROGRESS" &&
              status !== "CANCEL_IN_PROGRESS"
            );
          },
          times: 40,
        }),
      );
    });

    /**
     * Best-effort delete of the runtime parameter so the create route is
     * idempotent across retried invocations.
     */
    const cleanupRuntimeParam = deleteResource({
      TypeName: SSM_PARAMETER,
      Identifier: RUNTIME_PARAM,
    }).pipe(
      Effect.flatMap((r) =>
        r.ProgressEvent?.RequestToken !== undefined
          ? waitSettled(r.ProgressEvent.RequestToken)
          : Effect.succeed(undefined),
      ),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/fixture") {
          const result = yield* getResource({
            TypeName: SSM_PARAMETER,
            Identifier: FIXTURE_PARAM,
          });
          return yield* HttpServerResponse.json({
            identifier: result.ResourceDescription?.Identifier ?? null,
            value: readValue(result.ResourceDescription) ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/list") {
          // Bounded page walk looking for the fixture parameter.
          let nextToken: string | undefined;
          let found = false;
          let count = 0;
          for (let page = 0; page < 5 && !found; page++) {
            const result: cloudcontrol.ListResourcesOutput =
              yield* listResources({
                TypeName: SSM_PARAMETER,
                MaxResults: 100,
                NextToken: nextToken,
              });
            const descriptions = result.ResourceDescriptions ?? [];
            count += descriptions.length;
            found = descriptions.some(
              (description) => description.Identifier === FIXTURE_PARAM,
            );
            nextToken = result.NextToken;
            if (nextToken === undefined) break;
          }
          return yield* HttpServerResponse.json({ count, found });
        }

        if (request.method === "GET" && pathname === "/requests") {
          const result = yield* listResourceRequests({ MaxResults: 20 });
          return yield* HttpServerResponse.json({
            count: (result.ResourceRequestStatusSummaries ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/status-not-found") {
          // A token that never existed proves the grant end-to-end via the
          // typed error (an IAM gap would surface AccessDeniedException).
          const result = yield* getResourceRequestStatus({
            RequestToken: "00000000-0000-0000-0000-000000000000",
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag("RequestTokenNotFoundException", () =>
              Effect.succeed({ found: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/cancel-not-found") {
          const tag = yield* cancelResourceRequest({
            RequestToken: "00000000-0000-0000-0000-000000000000",
          }).pipe(
            Effect.map(() => "Cancelled"),
            Effect.catchTag(
              [
                "RequestTokenNotFoundException",
                "ConcurrentModificationException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "POST" && pathname === "/runtime-create") {
          const body = (yield* request.json) as unknown as { value: string };
          yield* cleanupRuntimeParam;
          const created = yield* createResource({
            TypeName: SSM_PARAMETER,
            DesiredState: JSON.stringify({
              Name: RUNTIME_PARAM,
              Type: "String",
              Value: body.value,
            }),
          });
          const settled = yield* waitSettled(
            created.ProgressEvent!.RequestToken!,
          );
          const result = yield* getResource({
            TypeName: SSM_PARAMETER,
            Identifier: RUNTIME_PARAM,
          });
          return yield* HttpServerResponse.json({
            status: settled.ProgressEvent?.OperationStatus ?? null,
            value: readValue(result.ResourceDescription) ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/runtime-update") {
          const body = (yield* request.json) as unknown as { value: string };
          const updated = yield* updateResource({
            TypeName: SSM_PARAMETER,
            Identifier: RUNTIME_PARAM,
            PatchDocument: JSON.stringify([
              { op: "replace", path: "/Value", value: body.value },
            ]),
          });
          const settled = yield* waitSettled(
            updated.ProgressEvent!.RequestToken!,
          );
          const result = yield* getResource({
            TypeName: SSM_PARAMETER,
            Identifier: RUNTIME_PARAM,
          });
          return yield* HttpServerResponse.json({
            status: settled.ProgressEvent?.OperationStatus ?? null,
            value: readValue(result.ResourceDescription) ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/runtime-delete") {
          const deleted = yield* deleteResource({
            TypeName: SSM_PARAMETER,
            Identifier: RUNTIME_PARAM,
          });
          const settled = yield* waitSettled(
            deleted.ProgressEvent!.RequestToken!,
          );
          // Bounded read-until-gone to absorb eventual consistency.
          const gone = yield* getResource({
            TypeName: SSM_PARAMETER,
            Identifier: RUNTIME_PARAM,
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (isGone): boolean => isGone,
              times: 5,
            }),
          );
          return yield* HttpServerResponse.json({
            status: settled.ProgressEvent?.OperationStatus ?? null,
            gone,
          });
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
        CloudControl.GetResourceHttp,
        CloudControl.ListResourcesHttp,
        CloudControl.CreateResourceHttp,
        CloudControl.UpdateResourceHttp,
        CloudControl.DeleteResourceHttp,
        CloudControl.GetResourceRequestStatusHttp,
        CloudControl.ListResourceRequestsHttp,
        CloudControl.CancelResourceRequestHttp,
      ),
    ),
  ),
);
