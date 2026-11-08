import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CloudSandboxCapabilities,
  CloudSandboxDetails,
  CloudSandboxDriverKind,
  CloudSandboxPrepareInput,
  CloudSandboxOperationResult,
  SandboxProfileId,
  SandboxUsage,
  SandboxRecording,
} from "./environment.ts";

export const MANAGED_CLOUD_SANDBOX_PATH = "/api/cloud-sandboxes/managed";
export const managedCloudSandboxProxyPath = (resourceId: string) =>
  `${MANAGED_CLOUD_SANDBOX_PATH}/${resourceId}/proxy`;
export const isManagedCloudSandboxProxyPath = (pathname: string): boolean =>
  /^\/api\/cloud-sandboxes\/managed\/[a-zA-Z0-9_-]{1,128}\/proxy\/?$/u.test(pathname);
export const MANAGED_CLOUD_SOURCE_PORT = 47773;
export const ManagedCloudSandboxResourceId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u),
).pipe(Schema.brand("ManagedCloudSandboxResourceId"));
export type ManagedCloudSandboxResourceId = typeof ManagedCloudSandboxResourceId.Type;
export const ManagedCloudSandboxResource = Schema.Struct({
  resourceId: ManagedCloudSandboxResourceId,
  controllerEnvironmentId: EnvironmentId,
  driverKind: CloudSandboxDriverKind,
  profileId: SandboxProfileId,
  sandboxId: Schema.NullOr(Schema.String),
  parentResourceId: Schema.NullOr(ManagedCloudSandboxResourceId),
  phase: Schema.Literals([
    "allocating",
    "connecting",
    "connected",
    "disconnected",
    "stopped",
    "deleting",
    "deleted",
    "failed",
  ]),
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.String,
  recordingIds: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ManagedCloudSandboxResource = typeof ManagedCloudSandboxResource.Type;
export const ManagedCloudSandboxConnection = Schema.Struct({
  sandboxId: Schema.String,
  driverKind: CloudSandboxDriverKind,
  resourceId: ManagedCloudSandboxResourceId,
  controllerEnvironmentId: EnvironmentId,
  environmentId: EnvironmentId,
  label: Schema.String,
  routePrefix: Schema.String,
  bearerToken: Schema.String,
});
export type ManagedCloudSandboxConnection = typeof ManagedCloudSandboxConnection.Type;
export const ManagedCloudSandboxProvisionInput = Schema.Struct({
  ...CloudSandboxPrepareInput.fields,
  operationId: ManagedCloudSandboxResourceId,
  enableLinkedEnvironments: Schema.optionalKey(Schema.Boolean),
});
export type ManagedCloudSandboxProvisionInput = typeof ManagedCloudSandboxProvisionInput.Type;
export const ManagedCloudSandboxForkInput = Schema.Struct({
  sourceResourceId: ManagedCloudSandboxResourceId,
  operationId: ManagedCloudSandboxResourceId,
  name: TrimmedNonEmptyString,
  size: Schema.optionalKey(Schema.String),
  autoStopMinutes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 43200 })),
  ),
  enableLinkedEnvironments: Schema.optionalKey(Schema.Boolean),
});
export type ManagedCloudSandboxForkInput = typeof ManagedCloudSandboxForkInput.Type;
export const ManagedCloudSandboxControlOperation = Schema.Union([
  Schema.TaggedStruct("usage", {}),
  Schema.TaggedStruct("recordingStart", { recordingId: ManagedCloudSandboxResourceId }),
  Schema.TaggedStruct("recordingStatus", { recordingId: ManagedCloudSandboxResourceId }),
  Schema.TaggedStruct("recordingStop", { recordingId: ManagedCloudSandboxResourceId }),
  Schema.TaggedStruct("resize", { size: Schema.String }),
  Schema.TaggedStruct("get", {}),
  Schema.TaggedStruct("stop", {}),
  Schema.TaggedStruct("resume", {}),
  Schema.TaggedStruct("desktop", {
    viewMode: Schema.optionalKey(Schema.Literals(["desktop", "browser"])),
  }),
  Schema.TaggedStruct("extend", {
    hours: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 720 })),
  }),
  Schema.TaggedStruct("host", {
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    isPublic: Schema.Boolean,
  }),
]);
export type ManagedCloudSandboxControlOperation = typeof ManagedCloudSandboxControlOperation.Type;
export const ManagedCloudSandboxControlResult = Schema.Union([
  ...CloudSandboxOperationResult.members,
  Schema.TaggedStruct("usage", { usage: SandboxUsage }),
  Schema.TaggedStruct("recording", { recording: SandboxRecording }),
]);
export type ManagedCloudSandboxControlResult = typeof ManagedCloudSandboxControlResult.Type;
export const ManagedCloudSandboxOperationResult = Schema.Union([
  Schema.TaggedStruct("connection", { connection: ManagedCloudSandboxConnection }),
  Schema.TaggedStruct("resource", { resource: ManagedCloudSandboxResource }),
  Schema.TaggedStruct("list", { resources: Schema.Array(ManagedCloudSandboxResource) }),
  Schema.TaggedStruct("result", { result: ManagedCloudSandboxControlResult }),
  Schema.TaggedStruct("deleted", {}),
  Schema.TaggedStruct("disconnected", {}),
]);
export type ManagedCloudSandboxOperationResult = typeof ManagedCloudSandboxOperationResult.Type;
export const ManagedCloudSandboxOperation = Schema.Union([
  Schema.TaggedStruct("provision", ManagedCloudSandboxProvisionInput.fields),
  Schema.TaggedStruct("connect", { resourceId: ManagedCloudSandboxResourceId }),
  Schema.TaggedStruct("get", { resourceId: ManagedCloudSandboxResourceId }),
  Schema.TaggedStruct("list", {}),
  Schema.TaggedStruct("execute", {
    resourceId: ManagedCloudSandboxResourceId,
    operation: ManagedCloudSandboxControlOperation,
  }),
  Schema.TaggedStruct("fork", ManagedCloudSandboxForkInput.fields),
  Schema.TaggedStruct("delete", { resourceId: ManagedCloudSandboxResourceId }),
  Schema.TaggedStruct("disconnect", { resourceId: ManagedCloudSandboxResourceId }),
]);
export type ManagedCloudSandboxOperation = typeof ManagedCloudSandboxOperation.Type;
export const ManagedCloudSandboxContext = Schema.Struct({
  resourceId: ManagedCloudSandboxResourceId,
  controllerEnvironmentId: EnvironmentId,
  controllerBaseUrl: Schema.String,
  grantToken: Schema.String,
});
export type ManagedCloudSandboxContext = typeof ManagedCloudSandboxContext.Type;

/** One managed sandbox located by its environment, for client control surfaces. */
export const CloudSandboxEnvironmentStatus = Schema.Struct({
  resourceId: ManagedCloudSandboxResourceId,
  controllerEnvironmentId: EnvironmentId,
  sandbox: CloudSandboxDetails,
  capabilities: CloudSandboxCapabilities,
  usage: Schema.NullOr(SandboxUsage),
  recordingIds: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CloudSandboxEnvironmentStatus = typeof CloudSandboxEnvironmentStatus.Type;
export const ManagedCloudSandboxSourceOperation = Schema.Union([
  Schema.TaggedStruct("host", {
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  }),
  Schema.TaggedStruct("get", { resourceId: Schema.optionalKey(ManagedCloudSandboxResourceId) }),
  Schema.TaggedStruct("status", { resourceId: ManagedCloudSandboxResourceId }),
  Schema.TaggedStruct("fork", {
    operationId: ManagedCloudSandboxForkInput.fields.operationId,
    name: ManagedCloudSandboxForkInput.fields.name,
    size: ManagedCloudSandboxForkInput.fields.size,
    autoStopMinutes: ManagedCloudSandboxForkInput.fields.autoStopMinutes,
    enableLinkedEnvironments: ManagedCloudSandboxForkInput.fields.enableLinkedEnvironments,
  }),
  Schema.TaggedStruct("connect", { resourceId: ManagedCloudSandboxResourceId }),
  Schema.TaggedStruct("delete", { resourceId: ManagedCloudSandboxResourceId }),
]);
export type ManagedCloudSandboxSourceOperation = typeof ManagedCloudSandboxSourceOperation.Type;

export const ManagedCloudSandboxSourceResult = Schema.Union([
  Schema.TaggedStruct("connection", {
    connection: ManagedCloudSandboxConnection,
    pairingToken: Schema.String,
  }),
  Schema.TaggedStruct("resource", { resource: ManagedCloudSandboxResource }),
  Schema.TaggedStruct("result", { result: ManagedCloudSandboxControlResult }),
  Schema.TaggedStruct("deleted", {}),
]);
export type ManagedCloudSandboxSourceResult = typeof ManagedCloudSandboxSourceResult.Type;
