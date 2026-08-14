import * as Schema from "effect/Schema";

/**
 * Computer History (Skysight-style): opt-in interaction-event capture that
 * becomes local memory summaries agents can reference. Off by default.
 */

export const ComputerHistoryAppFilterMode = Schema.Literals(["exclude", "includeOnly"]);
export type ComputerHistoryAppFilterMode = typeof ComputerHistoryAppFilterMode.Type;

export const ComputerHistoryWebsiteFilterMode = Schema.Literals(["exclude", "includeOnly"]);
export type ComputerHistoryWebsiteFilterMode = typeof ComputerHistoryWebsiteFilterMode.Type;

export const ComputerHistoryClearScope = Schema.Literals([
  "last_ten_minutes",
  "last_hour",
  "last_day",
  "all",
]);
export type ComputerHistoryClearScope = typeof ComputerHistoryClearScope.Type;

export const ComputerHistoryDaemonPhase = Schema.Literals([
  "stopped",
  "starting",
  "running",
  "paused",
  "error",
  "unavailable",
]);
export type ComputerHistoryDaemonPhase = typeof ComputerHistoryDaemonPhase.Type;

export const ComputerHistorySuggestionSchema = Schema.Struct({
  type: Schema.Literals(["skill", "automation"]),
  name: Schema.String,
  description: Schema.String,
});
export type ComputerHistorySuggestion = typeof ComputerHistorySuggestionSchema.Type;

export const ComputerHistoryTimelineItemSchema = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  title: Schema.String,
  description: Schema.String,
  level: Schema.Literals(["10min", "6h"]),
  startedAt: Schema.String,
  applications: Schema.Array(Schema.String),
  suggestion: Schema.optionalKey(ComputerHistorySuggestionSchema),
});
export type ComputerHistoryTimelineItem = typeof ComputerHistoryTimelineItemSchema.Type;

export const ComputerHistoryStatusSchema = Schema.Struct({
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  phase: ComputerHistoryDaemonPhase,
  accessibilityGranted: Schema.Boolean,
  rootPath: Schema.String,
  memoriesPath: Schema.String,
  codexMirrorPath: Schema.optionalKey(Schema.String),
  activeSegmentId: Schema.optionalKey(Schema.String),
  eventCount: Schema.Number,
  lastError: Schema.optionalKey(Schema.String),
  platform: Schema.String,
});
export type ComputerHistoryStatus = typeof ComputerHistoryStatusSchema.Type;

export const ComputerHistoryTimelineSchema = Schema.Struct({
  items: Schema.Array(ComputerHistoryTimelineItemSchema),
});
export type ComputerHistoryTimeline = typeof ComputerHistoryTimelineSchema.Type;
