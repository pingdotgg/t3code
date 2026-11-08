import {
  ManagedCloudSandboxSourceResult,
  type ManagedCloudSandboxSourceOperation,
  WorktreeMcpFailure,
  managedCloudSandboxProxyPath,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { readManagedCloudSandboxContext } from "../cloudSandbox/ManagedCloudSandboxContext.ts";

const decode = Schema.decodeUnknownEffect(ManagedCloudSandboxSourceResult);

export class CloudSandboxController extends Context.Service<
  CloudSandboxController,
  {
    readonly available: Effect.Effect<boolean, WorktreeMcpFailure>;
    readonly request: (
      input: ManagedCloudSandboxSourceOperation,
    ) => Effect.Effect<ManagedCloudSandboxSourceResult, WorktreeMcpFailure>;
  }
>()("t3/workspace/CloudSandboxController") {}

const failed = (message: string) => new WorktreeMcpFailure({ code: "operation_failed", message });
const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const context = yield* readManagedCloudSandboxContext.pipe(
    Effect.mapError(() => failed("Unable to read the managed sandbox controller context.")),
  );
  return CloudSandboxController.of({
    available: Effect.succeed(Option.isSome(context)),
    request: Effect.fn("CloudSandboxController.request")(function* (input) {
      const source = context;
      if (Option.isNone(source))
        return yield* new WorktreeMcpFailure({
          code: "invalid_request",
          message: "Sandbox isolation requires a managed cloud environment.",
        });
      const response = yield* client
        .execute(
          HttpClientRequest.post(
            `${source.value.controllerBaseUrl.replace(/\/$/, "")}/api/cloud-sandboxes/source`,
          ).pipe(
            HttpClientRequest.bearerToken(source.value.grantToken),
            HttpClientRequest.setHeader("X-T3-Cloud-Resource", source.value.resourceId),
            HttpClientRequest.bodyJsonUnsafe(input),
          ),
        )
        .pipe(Effect.mapError(() => failed("The sandbox controller is unavailable.")));
      if (response.status >= 400)
        return yield* failed(
          "The sandbox controller refused the workspace operation. Check its permissions and connection.",
        );
      const result = yield* response.json.pipe(
        Effect.flatMap(decode),
        Effect.mapError(() => failed("The sandbox controller returned an invalid response.")),
      );
      if (result._tag !== "connection") return result;
      const prefix = managedCloudSandboxProxyPath(encodeURIComponent(result.connection.resourceId));
      if (result.connection.routePrefix !== prefix)
        return yield* failed("The sandbox controller returned an invalid managed route.");
      return {
        ...result,
        connection: {
          ...result.connection,
          routePrefix: `${source.value.controllerBaseUrl.replace(/\/$/, "")}${prefix}`,
        },
      };
    }),
  });
});
export const layer = Layer.effect(CloudSandboxController, make);
