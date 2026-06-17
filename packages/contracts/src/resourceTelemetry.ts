import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HostPowerSnapshot } from "./background.ts";

export const RESOURCE_MONITOR_PROTOCOL_VERSION = 2 as const;

export const ResourceTelemetryIoSemantics = Schema.Literals([
  "storage",
  "logical",
  "all-io",
  "unavailable",
]);
export type ResourceTelemetryIoSemantics = typeof ResourceTelemetryIoSemantics.Type;

export const ResourceTelemetryProcessCategory = Schema.Literals([
  "server",
  "server-child",
  "provider-root",
  "terminal-root",
  "electron-main",
  "electron-renderer",
  "electron-gpu",
  "electron-utility",
  "resource-monitor",
  "unknown-t3",
]);
export type ResourceTelemetryProcessCategory = typeof ResourceTelemetryProcessCategory.Type;

export const ResourceTelemetrySourceStatus = Schema.Literals([
  "starting",
  "healthy",
  "degraded",
  "unavailable",
  "stopped",
]);
export type ResourceTelemetrySourceStatus = typeof ResourceTelemetrySourceStatus.Type;

export const ResourceTelemetryProcessIdentity = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
});
export type ResourceTelemetryProcessIdentity = typeof ResourceTelemetryProcessIdentity.Type;

export const ResourceMonitorExternalProcess = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: Schema.optionalKey(NonNegativeInt),
});
export type ResourceMonitorExternalProcess = typeof ResourceMonitorExternalProcess.Type;

export const ResourceMonitorCapabilities = Schema.Struct({
  cumulativeCpuTime: Schema.Boolean,
  currentCpuPercent: Schema.Boolean,
  residentMemory: Schema.Boolean,
  virtualMemory: Schema.Boolean,
  ioBytes: Schema.Boolean,
  processStartTime: Schema.Boolean,
  processTree: Schema.Boolean,
});
export type ResourceMonitorCapabilities = typeof ResourceMonitorCapabilities.Type;

export const ResourceMonitorProcessSample = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  startTimeMs: NonNegativeInt,
  runTimeMs: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  status: Schema.String,
  cpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  residentBytes: NonNegativeInt,
  virtualBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioSemantics: Schema.Literals(["storage", "all-io"]),
});
export type ResourceMonitorProcessSample = typeof ResourceMonitorProcessSample.Type;

export const ResourceMonitorConfigureCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("configure"),
  rootPid: PositiveInt,
  sampleIntervalMs: NonNegativeInt,
  externalProcesses: Schema.Array(ResourceMonitorExternalProcess),
});
export type ResourceMonitorConfigureCommand = typeof ResourceMonitorConfigureCommand.Type;

export const ResourceMonitorSetExternalProcessesCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("setExternalProcesses"),
  processes: Schema.Array(ResourceMonitorExternalProcess),
});
export type ResourceMonitorSetExternalProcessesCommand =
  typeof ResourceMonitorSetExternalProcessesCommand.Type;

export const ResourceMonitorSampleNowCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("sampleNow"),
  requestId: TrimmedNonEmptyString,
});
export type ResourceMonitorSampleNowCommand = typeof ResourceMonitorSampleNowCommand.Type;

export const ResourceMonitorSetSampleIntervalCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("setSampleInterval"),
  sampleIntervalMs: NonNegativeInt,
});
export type ResourceMonitorSetSampleIntervalCommand =
  typeof ResourceMonitorSetSampleIntervalCommand.Type;

export const ResourceMonitorSetStreamingCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("setStreaming"),
  enabled: Schema.Boolean,
});
export type ResourceMonitorSetStreamingCommand = typeof ResourceMonitorSetStreamingCommand.Type;

export const ResourceMonitorReadHistoryCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("readHistory"),
  requestId: TrimmedNonEmptyString,
  windowMs: NonNegativeInt,
});
export type ResourceMonitorReadHistoryCommand = typeof ResourceMonitorReadHistoryCommand.Type;

export const ResourceMonitorShutdownCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("shutdown"),
});
export type ResourceMonitorShutdownCommand = typeof ResourceMonitorShutdownCommand.Type;

export const ResourceMonitorCommand = Schema.Union([
  ResourceMonitorConfigureCommand,
  ResourceMonitorSetExternalProcessesCommand,
  ResourceMonitorSetSampleIntervalCommand,
  ResourceMonitorSetStreamingCommand,
  ResourceMonitorSampleNowCommand,
  ResourceMonitorReadHistoryCommand,
  ResourceMonitorShutdownCommand,
]);
export type ResourceMonitorCommand = typeof ResourceMonitorCommand.Type;

export const ResourceMonitorHelloEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("hello"),
  sidecarVersion: TrimmedNonEmptyString,
  sidecarPid: PositiveInt,
  platform: TrimmedNonEmptyString,
  arch: TrimmedNonEmptyString,
  capabilities: ResourceMonitorCapabilities,
});
export type ResourceMonitorHelloEvent = typeof ResourceMonitorHelloEvent.Type;

export const ResourceMonitorSnapshotEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("snapshot"),
  sequence: NonNegativeInt,
  sampledAtUnixMs: NonNegativeInt,
  collectionDurationMicros: NonNegativeInt,
  scannedProcessCount: NonNegativeInt,
  retainedProcessCount: NonNegativeInt,
  inaccessibleProcessCount: NonNegativeInt,
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  processes: Schema.Array(ResourceMonitorProcessSample),
});
export type ResourceMonitorSnapshotEvent = typeof ResourceMonitorSnapshotEvent.Type;

export const ResourceMonitorHistoryChunkEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("historyChunk"),
  requestId: TrimmedNonEmptyString,
  done: Schema.Boolean,
  snapshots: Schema.Array(ResourceMonitorSnapshotEvent),
});
export type ResourceMonitorHistoryChunkEvent = typeof ResourceMonitorHistoryChunkEvent.Type;

export const ResourceMonitorErrorEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("error"),
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  recoverable: Schema.Boolean,
});
export type ResourceMonitorErrorEvent = typeof ResourceMonitorErrorEvent.Type;

export const ResourceMonitorEvent = Schema.Union([
  ResourceMonitorHelloEvent,
  ResourceMonitorSnapshotEvent,
  ResourceMonitorHistoryChunkEvent,
  ResourceMonitorErrorEvent,
]);
export type ResourceMonitorEvent = typeof ResourceMonitorEvent.Type;

export const DesktopElectronProcessType = Schema.Literals([
  "Browser",
  "Tab",
  "Utility",
  "Zygote",
  "Sandbox helper",
  "GPU",
  "Pepper Plugin",
  "Pepper Plugin Broker",
  "Unknown",
]);
export type DesktopElectronProcessType = typeof DesktopElectronProcessType.Type;

export const DesktopElectronProcessMetric = Schema.Struct({
  pid: PositiveInt,
  creationTimeMs: NonNegativeInt,
  type: DesktopElectronProcessType,
  name: Schema.optionalKey(Schema.String),
  serviceName: Schema.optionalKey(Schema.String),
  cpuPercent: Schema.Number,
  cumulativeCpuSeconds: Schema.optionalKey(Schema.Number),
  idleWakeupsPerSecond: Schema.Number,
  workingSetBytes: NonNegativeInt,
  peakWorkingSetBytes: NonNegativeInt,
});
export type DesktopElectronProcessMetric = typeof DesktopElectronProcessMetric.Type;

export const DesktopHostTelemetrySnapshot = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopTelemetry"),
  sequence: NonNegativeInt,
  sampledAtUnixMs: NonNegativeInt,
  electronPid: PositiveInt,
  power: HostPowerSnapshot,
  speedLimitPercent: Schema.Option(Schema.Number),
  electronProcesses: Schema.Array(DesktopElectronProcessMetric),
});
export type DesktopHostTelemetrySnapshot = typeof DesktopHostTelemetrySnapshot.Type;

export const DesktopHostTelemetryHello = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopTelemetryHello"),
  electronPid: PositiveInt,
});
export type DesktopHostTelemetryHello = typeof DesktopHostTelemetryHello.Type;

export const DesktopHostTelemetryMessage = Schema.Union([
  DesktopHostTelemetryHello,
  DesktopHostTelemetrySnapshot,
]);
export type DesktopHostTelemetryMessage = typeof DesktopHostTelemetryMessage.Type;

export const DesktopTelemetrySetDiagnosticsDemand = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("setDiagnosticsDemand"),
  enabled: Schema.Boolean,
});
export type DesktopTelemetrySetDiagnosticsDemand = typeof DesktopTelemetrySetDiagnosticsDemand.Type;

export const DesktopTelemetryControlMessage = Schema.Union([DesktopTelemetrySetDiagnosticsDemand]);
export type DesktopTelemetryControlMessage = typeof DesktopTelemetryControlMessage.Type;

export const ResourceTelemetryProcess = Schema.Struct({
  identity: ResourceTelemetryProcessIdentity,
  ppid: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  status: Schema.String,
  category: ResourceTelemetryProcessCategory,
  electronType: Schema.optionalKey(DesktopElectronProcessType),
  electronServiceName: Schema.optionalKey(Schema.String),
  cpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  residentBytes: NonNegativeInt,
  peakResidentBytes: NonNegativeInt,
  virtualBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  ioSemantics: ResourceTelemetryIoSemantics,
  idleWakeupsPerSecond: Schema.optionalKey(Schema.Number),
  runTimeMs: NonNegativeInt,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
});
export type ResourceTelemetryProcess = typeof ResourceTelemetryProcess.Type;

export const ResourceTelemetryAggregate = Schema.Struct({
  processCount: NonNegativeInt,
  currentCpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  currentRssBytes: NonNegativeInt,
  peakRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  processStarts: NonNegativeInt,
  processExits: NonNegativeInt,
});
export type ResourceTelemetryAggregate = typeof ResourceTelemetryAggregate.Type;

export const ResourceTelemetryGroups = Schema.Struct({
  backend: ResourceTelemetryAggregate,
  electron: ResourceTelemetryAggregate,
  monitor: ResourceTelemetryAggregate,
  allT3: ResourceTelemetryAggregate,
});
export type ResourceTelemetryGroups = typeof ResourceTelemetryGroups.Type;

export const ResourceTelemetrySourceHealth = Schema.Struct({
  status: ResourceTelemetrySourceStatus,
  lastSampleAt: Schema.Option(Schema.DateTimeUtc),
  lastError: Schema.Option(TrimmedNonEmptyString),
});
export type ResourceTelemetrySourceHealth = typeof ResourceTelemetrySourceHealth.Type;

export const ResourceTelemetryHealth = Schema.Struct({
  native: ResourceTelemetrySourceHealth,
  desktop: ResourceTelemetrySourceHealth,
  sidecarVersion: Schema.Option(TrimmedNonEmptyString),
  sidecarPid: Schema.Option(PositiveInt),
  restartCount: NonNegativeInt,
  collectionDurationMicros: NonNegativeInt,
  scannedProcessCount: NonNegativeInt,
  retainedProcessCount: NonNegativeInt,
  inaccessibleProcessCount: NonNegativeInt,
});
export type ResourceTelemetryHealth = typeof ResourceTelemetryHealth.Type;

export const ResourceAttributionEntry = Schema.Struct({
  component: TrimmedNonEmptyString,
  operation: TrimmedNonEmptyString,
  logicalReadBytes: NonNegativeInt,
  logicalWriteBytes: NonNegativeInt,
  count: NonNegativeInt,
  durationMs: NonNegativeInt,
});
export type ResourceAttributionEntry = typeof ResourceAttributionEntry.Type;

export const ResourceAttributionSnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  entries: Schema.Array(ResourceAttributionEntry),
});
export type ResourceAttributionSnapshot = typeof ResourceAttributionSnapshot.Type;

export const ResourceTelemetrySnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  sampleIntervalMs: NonNegativeInt,
  processes: Schema.Array(ResourceTelemetryProcess),
  groups: ResourceTelemetryGroups,
  power: HostPowerSnapshot,
  speedLimitPercent: Schema.Option(Schema.Number),
  attribution: ResourceAttributionSnapshot,
  health: ResourceTelemetryHealth,
});
export type ResourceTelemetrySnapshot = typeof ResourceTelemetrySnapshot.Type;

export const ResourceTelemetryHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ResourceTelemetryHistoryInput = typeof ResourceTelemetryHistoryInput.Type;

export const ResourceTelemetryHistoryBucket = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  maxRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  maxProcessCount: NonNegativeInt,
});
export type ResourceTelemetryHistoryBucket = typeof ResourceTelemetryHistoryBucket.Type;

export const ResourceTelemetryProcessSummary = Schema.Struct({
  identity: ResourceTelemetryProcessIdentity,
  ppid: NonNegativeInt,
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  category: ResourceTelemetryProcessCategory,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  currentRssBytes: NonNegativeInt,
  peakRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioSemantics: ResourceTelemetryIoSemantics,
  sampleCount: NonNegativeInt,
});
export type ResourceTelemetryProcessSummary = typeof ResourceTelemetryProcessSummary.Type;

export const ResourceTelemetryHistory = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  buckets: Schema.Array(ResourceTelemetryHistoryBucket),
  topProcesses: Schema.Array(ResourceTelemetryProcessSummary),
  health: ResourceTelemetryHealth,
});
export type ResourceTelemetryHistory = typeof ResourceTelemetryHistory.Type;

export const ResourceTelemetryRetryResult = Schema.Struct({
  accepted: Schema.Boolean,
  snapshot: ResourceTelemetrySnapshot,
});
export type ResourceTelemetryRetryResult = typeof ResourceTelemetryRetryResult.Type;
