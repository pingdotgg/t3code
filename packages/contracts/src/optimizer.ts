import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const OptimizerId = Schema.Literals(["rtk", "headroom", "cbm"]);
export type OptimizerId = typeof OptimizerId.Type;

export class OptimizerStartError extends Schema.TaggedError<OptimizerStartError>()(
  "OptimizerStartError",
  { message: Schema.String },
) {}

export const OptimizerMode = Schema.Literals(["cli-wrapper", "detected-proxy", "stdio-mcp"]);
export type OptimizerMode = typeof OptimizerMode.Type;

export const OptimizerStatus = Schema.Struct({
  id: OptimizerId,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  running: Schema.optionalKey(Schema.Boolean),
  mode: OptimizerMode,
  checkedAt: IsoDateTime,
  detail: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OptimizerStatus = typeof OptimizerStatus.Type;

/** The period covered by an optimizer's own counter. */
export const OptimizerSavingsWindow = Schema.Literals(["all-time", "session"]);
export type OptimizerSavingsWindow = typeof OptimizerSavingsWindow.Type;

/**
 * Token reduction reported by a host-local optimizer. These counters cover the
 * whole environment. They are never scoped to the project currently open in a
 * client.
 */
export const OptimizerSavingsSummary = Schema.Struct({
  source: Schema.Literals(["rtk", "headroom"]),
  scope: Schema.Literal("environment"),
  window: OptimizerSavingsWindow,
  tokensSaved: NonNegativeInt,
});
export type OptimizerSavingsSummary = typeof OptimizerSavingsSummary.Type;

export const OptimizerSavingsInterval = Schema.Literals(["hour", "day", "week", "month"]);
export type OptimizerSavingsInterval = typeof OptimizerSavingsInterval.Type;

/** A Headroom rollup delta from the host-local savings history. */
export const OptimizerSavingsPoint = Schema.Struct({
  source: Schema.Literal("headroom"),
  scope: Schema.Literal("environment"),
  interval: OptimizerSavingsInterval,
  timestamp: IsoDateTime,
  tokensSaved: NonNegativeInt,
});
export type OptimizerSavingsPoint = typeof OptimizerSavingsPoint.Type;

export const OptimizerAttachmentStatus = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  configured: Schema.Array(OptimizerId),
  attached: Schema.Array(OptimizerId),
  ready: Schema.Array(OptimizerId),
});
export type OptimizerAttachmentStatus = typeof OptimizerAttachmentStatus.Type;

/** The local CLIProxyAPI proxy and whether the Claude and Codex CLI configs route through it. */
export const CpaStatus = Schema.Struct({
  url: TrimmedNonEmptyString,
  running: Schema.Boolean,
  /** Derived from the CLI config files; "partial" means only one of Claude or Codex routes. */
  routing: Schema.Literals(["on", "off", "partial"]),
  canStart: Schema.Boolean,
  /** A Headroom T3 cannot restart forwards to a different upstream than the switch implies. */
  headroomUpstreamMismatch: Schema.Boolean,
});
export type CpaStatus = typeof CpaStatus.Type;

export const OptimizerStatusSnapshot = Schema.Struct({
  optimizers: Schema.Array(OptimizerStatus),
  savings: Schema.Array(OptimizerSavingsSummary),
  savingsHistory: Schema.Array(OptimizerSavingsPoint),
  cbmIndexes: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      repoPath: TrimmedNonEmptyString,
      state: Schema.Literals(["indexing", "ready", "degraded"]),
      checkedAt: IsoDateTime,
      nodeCount: Schema.optionalKey(NonNegativeInt),
      edgeCount: Schema.optionalKey(NonNegativeInt),
      detail: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
  attachments: Schema.Array(OptimizerAttachmentStatus).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  cpa: Schema.optionalKey(CpaStatus),
});
export type OptimizerStatusSnapshot = typeof OptimizerStatusSnapshot.Type;

export const CbmProjectIndexStatus = OptimizerStatusSnapshot.fields.cbmIndexes.value;
export type CbmProjectIndexStatus = typeof CbmProjectIndexStatus.Type;

/** Stored per-project choices. Omitted fields from older settings decode off. */
export const ProjectOptimizerSettings = Schema.Struct({
  rtk: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  headroom: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  cbm: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ProjectOptimizerSettings = typeof ProjectOptimizerSettings.Type;

/** A partial project row accepted by the settings patch RPC. */
export const ProjectOptimizerSettingsPatch = Schema.Struct({
  rtk: Schema.optionalKey(Schema.Boolean),
  headroom: Schema.optionalKey(Schema.Boolean),
  cbm: Schema.optionalKey(Schema.Boolean),
});
export type ProjectOptimizerSettingsPatch = typeof ProjectOptimizerSettingsPatch.Type;

export const DEFAULT_CBM_BINARY_PATH = "codebase-memory-mcp";

export const DEFAULT_HEADROOM_PROXY_URL = "http://127.0.0.1:6767";

export const DEFAULT_CPA_SETTINGS = {
  url: "http://127.0.0.1:8317",
  clientKeyPath: "~/.config/cpa/key",
  managementKeyPath: "~/.config/cpa/management-key",
  launchdLabel: "com.nabeel.cliproxyapi",
} as const;

/** Return the canonical origin for a local Headroom proxy URL. */
export function normalizeHeadroomProxyUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const isLoopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (
      url.protocol !== "http:" ||
      !isLoopback ||
      url.pathname !== "/" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

const HeadroomProxyUrlFilter = Schema.makeFilter((value: string) =>
  normalizeHeadroomProxyUrl(value) === null
    ? "Expected an HTTP loopback origin without credentials, query, fragment, or path."
    : undefined,
);

export const HeadroomProxyUrl = TrimmedNonEmptyString.check(HeadroomProxyUrlFilter);
export type HeadroomProxyUrl = typeof HeadroomProxyUrl.Type;
