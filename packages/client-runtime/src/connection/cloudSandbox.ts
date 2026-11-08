import {
  type CloudSandboxEnvironmentStatus,
  type EnvironmentId,
  type ManagedCloudSandboxControlOperation,
  type ManagedCloudSandboxControlResult,
  type ManagedCloudSandboxOperation,
  ManagedCloudSandboxResourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ConnectionBlockedError } from "./model.ts";
import { CloudSandboxDirectory } from "./cloudSandboxDirectory.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import {
  downloadCloudSandboxRecording,
  makeManagedCloudSandboxClient,
  openCloudSandboxPreview,
} from "./managedCloudSandbox.ts";

const decodeRecordingId = Schema.decodeEffect(ManagedCloudSandboxResourceId);

const configuration = (detail: string) =>
  new ConnectionBlockedError({ reason: "configuration", detail });

const scanForSandbox = Effect.fn("clientRuntime.cloudSandbox.scanForSandbox")(
  (environmentId: EnvironmentId) =>
    CloudSandboxDirectory.pipe(Effect.flatMap((directory) => directory.find(environmentId))),
);

/** Runs one operation on a sandbox controller, located by its environment id. */
const controllerOperation = Effect.fn("clientRuntime.cloudSandbox.controllerOperation")(function* (
  controllerEnvironmentId: EnvironmentId,
  operation: ManagedCloudSandboxOperation,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const controller = yield* registry
    .run(
      controllerEnvironmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.pipe(
        Effect.flatMap((supervisor) => SubscriptionRef.get(supervisor.prepared)),
        Effect.flatMap((prepared) =>
          Effect.fromOption(prepared, () =>
            configuration("The sandbox controller is not connected."),
          ),
        ),
      ),
    )
    .pipe(Effect.mapError((cause) => configuration(cause.message)));
  const operate = yield* makeManagedCloudSandboxClient;
  return yield* operate(controller, operation);
});

/** Every sandbox a controller manages, including ones not yet connected to this client. */
export const listManagedSandboxes = Effect.fn("clientRuntime.cloudSandbox.listManagedSandboxes")(
  function* (controllerEnvironmentId: EnvironmentId) {
    const response = yield* controllerOperation(controllerEnvironmentId, { _tag: "list" });
    if (response._tag !== "list")
      return yield* configuration("Unexpected cloud sandbox list response.");
    return response.resources;
  },
);

/** Deletes a managed sandbox resource on its controller. */
export const deleteManagedSandbox = Effect.fn("clientRuntime.cloudSandbox.deleteManagedSandbox")(
  function* (controllerEnvironmentId: EnvironmentId, resourceId: ManagedCloudSandboxResourceId) {
    const response = yield* controllerOperation(controllerEnvironmentId, {
      _tag: "delete",
      resourceId,
    });
    if (response._tag !== "deleted")
      return yield* configuration("Unexpected cloud sandbox delete response.");
  },
);

/** Status, capabilities, usage, and recording ids of a sandbox located by environment. */
export const loadEnvironmentSandboxStatus = Effect.fn(
  "clientRuntime.cloudSandbox.loadEnvironmentSandboxStatus",
)(function* (environmentId: EnvironmentId) {
  const found = yield* scanForSandbox(environmentId);
  if (found === null) return null;
  const operate = yield* makeManagedCloudSandboxClient;
  const read = yield* operate(found.controller, {
    _tag: "execute",
    resourceId: found.resource.resourceId,
    operation: { _tag: "get" },
  });
  if (read._tag !== "result" || read.result._tag !== "status")
    return yield* configuration("Unexpected cloud sandbox status response.");
  const usage =
    read.result.capabilities.usage === true
      ? yield* operate(found.controller, {
          _tag: "execute",
          resourceId: found.resource.resourceId,
          operation: { _tag: "usage" },
        }).pipe(
          Effect.flatMap((response) =>
            response._tag === "result" && response.result._tag === "usage"
              ? Effect.succeed(response.result.usage)
              : Effect.succeed(null),
          ),
          Effect.orElseSucceed(() => null),
        )
      : null;
  const status: CloudSandboxEnvironmentStatus = {
    resourceId: found.resource.resourceId,
    controllerEnvironmentId: found.resource.controllerEnvironmentId,
    sandbox: read.result.sandbox,
    capabilities: read.result.capabilities,
    usage,
    recordingIds: found.resource.recordingIds,
  };
  return status;
});

/** Runs one control operation against an environment's managed sandbox. */
export const executeEnvironmentSandboxControl = Effect.fn(
  "clientRuntime.cloudSandbox.executeEnvironmentSandboxControl",
)(function* (environmentId: EnvironmentId, operation: ManagedCloudSandboxControlOperation) {
  const found = yield* scanForSandbox(environmentId);
  if (found === null) return yield* configuration("This environment has no managed cloud sandbox.");
  const operate = yield* makeManagedCloudSandboxClient;
  const response = yield* operate(found.controller, {
    _tag: "execute",
    resourceId: found.resource.resourceId,
    operation,
  });
  if (response._tag !== "result") return yield* configuration("Unexpected cloud sandbox response.");
  return response.result satisfies ManagedCloudSandboxControlResult;
});

/** The most recent recording of an environment's sandbox, when one exists. */
export const recoverEnvironmentSandboxRecording = Effect.fn(
  "clientRuntime.cloudSandbox.recoverEnvironmentSandboxRecording",
)(function* (environmentId: EnvironmentId) {
  const statusData = yield* loadEnvironmentSandboxStatus(environmentId);
  if (statusData === null) return null;
  for (const id of [...statusData.recordingIds].reverse()) {
    const recordingId = yield* decodeRecordingId(id).pipe(Effect.option);
    if (Option.isNone(recordingId)) continue;
    const result = yield* executeEnvironmentSandboxControl(environmentId, {
      _tag: "recordingStatus",
      recordingId: recordingId.value,
    }).pipe(Effect.option);
    if (Option.isSome(result) && result.value._tag === "recording") return result.value.recording;
  }
  return null;
});

/** Downloads a finished recording of an environment's sandbox. */
export const downloadEnvironmentSandboxRecording = Effect.fn(
  "clientRuntime.cloudSandbox.downloadEnvironmentSandboxRecording",
)(function* (environmentId: EnvironmentId, recordingId: ManagedCloudSandboxResourceId) {
  const found = yield* scanForSandbox(environmentId);
  if (found === null) return yield* configuration("This environment has no managed cloud sandbox.");
  return yield* downloadCloudSandboxRecording(
    found.controller,
    found.resource.resourceId,
    recordingId,
  );
});

/** Opens a hosted preview of a sandbox's loopback service, for external viewing. */
export const openEnvironmentSandboxPreview = Effect.fn(
  "clientRuntime.cloudSandbox.openEnvironmentSandboxPreview",
)(function* (
  environmentId: EnvironmentId,
  url: string,
  access: "local" | "protected",
  close = false,
) {
  const found = yield* scanForSandbox(environmentId);
  if (found === null) return yield* configuration("This environment has no managed cloud sandbox.");
  return yield* openCloudSandboxPreview(
    found.controller,
    found.resource.resourceId,
    url,
    access,
    close,
  );
});
