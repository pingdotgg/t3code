import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { EnvironmentHttpCommonError } from "./environmentHttp.ts";
import {
  ManagedCloudSandboxResourceId,
  MANAGED_CLOUD_SANDBOX_PATH,
  ManagedCloudSandboxOperation,
  ManagedCloudSandboxOperationResult,
} from "./managedCloudSandbox.ts";

export class ManagedCloudSandboxControlError extends Schema.TaggedError<ManagedCloudSandboxControlError>()(
  "ManagedCloudSandboxControlError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The cloud sandbox operation failed. Check the sandbox state and your connection to its controller.";
  }
}

export class CloudSandboxProfileError extends Schema.TaggedError<CloudSandboxProfileError>()(
  "CloudSandboxProfileError",
  {
    reason: Schema.Literals([
      "not-found",
      "storage",
      "missing-key",
      "budget",
      "provider",
      "in-use",
    ]),
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-found":
        return "No sandbox profile exists with that id.";
      case "storage":
        return "The sandbox profile could not be stored.";
      case "missing-key":
        return "The sandbox profile has no API key set.";
      case "budget":
        return this.detail ?? "The profile's monthly sandbox budget is exhausted.";
      case "provider":
        return this.detail ?? "The sandbox provider rejected the operation.";
      case "in-use":
        return this.detail ?? "Sandboxes provisioned from this profile still exist.";
    }
  }
}

export class ManagedCloudSandboxHttpApi extends HttpApiGroup.make("managedCloudSandbox").add(
  HttpApiEndpoint.post("preview", `${MANAGED_CLOUD_SANDBOX_PATH}/preview`, {
    headers: Schema.Struct({
      authorization: Schema.optionalKey(Schema.String),
      dpop: Schema.optionalKey(Schema.String),
    }),
    payload: Schema.Struct({
      resourceId: ManagedCloudSandboxResourceId,
      url: Schema.String,
      access: Schema.optionalKey(Schema.Literals(["local", "protected"])),
      close: Schema.optionalKey(Schema.Boolean),
    }),
    success: Schema.Struct({ url: Schema.String }),
    error: EnvironmentHttpCommonError,
  }),
  HttpApiEndpoint.post("operate", MANAGED_CLOUD_SANDBOX_PATH, {
    headers: Schema.Struct({
      authorization: Schema.optionalKey(Schema.String),
      dpop: Schema.optionalKey(Schema.String),
    }),
    payload: ManagedCloudSandboxOperation,
    success: ManagedCloudSandboxOperationResult,
    error: EnvironmentHttpCommonError,
  }),
  HttpApiEndpoint.get(
    "artifact",
    `${MANAGED_CLOUD_SANDBOX_PATH}/:resourceId/recordings/:recordingId`,
    {
      params: Schema.Struct({
        resourceId: ManagedCloudSandboxResourceId,
        recordingId: ManagedCloudSandboxResourceId,
      }),
      headers: Schema.Struct({
        authorization: Schema.optionalKey(Schema.String),
        dpop: Schema.optionalKey(Schema.String),
      }),
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "video/mp4" })),
      error: EnvironmentHttpCommonError,
    },
  ),
) {}
