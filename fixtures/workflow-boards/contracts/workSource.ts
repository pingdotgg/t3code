import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LaneKey, TicketId, WorkSourceProviderName } from "./workflow.ts";
import type { WorkflowSourceConfig } from "./workflow.ts";

// SourceId and WorkSourceProviderName are defined in workflow.ts (to avoid an
// import cycle: workSource.ts imports LaneKey from workflow.ts, so workflow.ts
// cannot import from workSource.ts). They are re-exported here so callers can
// import everything source-related from the workSource contract module.
export {
  LaneKey,
  SourceId,
  TicketId,
  WorkSourceProviderName,
  WorkflowSourceConfig,
  WorkSourceAutoPull,
} from "./workflow.ts";

// -- Auto-pull rule helpers ----------------------------------------------------

export const ALWAYS_RULE = true as const;

export interface AutoPullCriteria {
  readonly labels?: { readonly mode: "any" | "all"; readonly values: ReadonlyArray<string> };
  readonly assignee?:
    | { readonly kind: "anyone" }
    | { readonly kind: "login"; readonly value: string };
  readonly state?: "open" | "closed";
}

const labelIn = (label: string) => ({ in: [label, { var: "labels" }] });

export const compileAutoPullRule = (c: AutoPullCriteria): unknown => {
  const clauses: Array<unknown> = [];
  if (c.labels && c.labels.values.length > 0) {
    const ins = c.labels.values.map(labelIn);
    clauses.push(ins.length === 1 ? ins[0] : { [c.labels.mode === "any" ? "or" : "and"]: ins });
  }
  if (c.assignee)
    clauses.push(
      c.assignee.kind === "anyone"
        ? { var: "assignees" }
        : { in: [c.assignee.value, { var: "assignees" }] },
    );
  if (c.state) clauses.push({ "==": [{ var: "state" }, c.state] });
  if (clauses.length === 0) return ALWAYS_RULE;
  return clauses.length === 1 ? clauses[0] : { and: clauses };
};

type DecodedClause =
  | { kind: "labels"; value: AutoPullCriteria["labels"] }
  | { kind: "assignee"; value: AutoPullCriteria["assignee"] }
  | { kind: "state"; value: AutoPullCriteria["state"] };

// Try to decode a single jsonLogic sub-expression into a typed clause.
const decodeClause = (clause: unknown): DecodedClause | null => {
  if (typeof clause !== "object" || clause === null) return null;
  const obj = clause as Record<string, unknown>;

  // { var: "assignees" } -> assignee: anyone
  if ("var" in obj && obj.var === "assignees") {
    return { kind: "assignee", value: { kind: "anyone" } };
  }

  // { "==": [{ var: "state" }, "open"|"closed"] }
  if ("==" in obj && Array.isArray(obj["=="])) {
    const [left, right] = obj["=="] as unknown[];
    if (
      typeof left === "object" &&
      left !== null &&
      (left as Record<string, unknown>).var === "state" &&
      (right === "open" || right === "closed")
    ) {
      return { kind: "state", value: right };
    }
  }

  // { in: [...] }
  if ("in" in obj && Array.isArray(obj.in)) {
    const [val, varExpr] = obj.in as unknown[];
    if (typeof val === "string" && typeof varExpr === "object" && varExpr !== null) {
      const varName = (varExpr as Record<string, unknown>).var;
      // { in: [label, { var: "labels" }] } -> labels any single
      if (varName === "labels") {
        return { kind: "labels", value: { mode: "any", values: [val] } };
      }
      // { in: [login, { var: "assignees" }] } -> assignee: login
      if (varName === "assignees") {
        return { kind: "assignee", value: { kind: "login", value: val } };
      }
    }
  }

  // { or: [{in:[v,{var:"labels"}]}, ...] } -> labels any multi
  if ("or" in obj && Array.isArray(obj.or)) {
    const values = decodeLabelList(obj.or as unknown[]);
    if (values !== null) return { kind: "labels", value: { mode: "any", values } };
  }

  // { and: [{in:[v,{var:"labels"}]}, ...] } -> labels all multi
  if ("and" in obj && Array.isArray(obj.and)) {
    const values = decodeLabelList(obj.and as unknown[]);
    if (values !== null) return { kind: "labels", value: { mode: "all", values } };
  }

  return null;
};

const decodeLabelList = (items: unknown[]): string[] | null => {
  const values: string[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) return null;
    const obj = item as Record<string, unknown>;
    if (!("in" in obj) || !Array.isArray(obj.in)) return null;
    const [val, varExpr] = obj.in as unknown[];
    if (typeof val !== "string" || typeof varExpr !== "object" || varExpr === null) return null;
    if ((varExpr as Record<string, unknown>).var !== "labels") return null;
    values.push(val);
  }
  return values.length > 0 ? values : null;
};

// Build an AutoPullCriteria from an array of decoded clauses (null if duplicate kinds).
const clausesToCriteria = (clauses: DecodedClause[]): AutoPullCriteria | null => {
  let labels: AutoPullCriteria["labels"] | undefined;
  let assignee: AutoPullCriteria["assignee"] | undefined;
  let state: AutoPullCriteria["state"] | undefined;
  for (const c of clauses) {
    if (c.kind === "labels") {
      if (labels !== undefined) return null;
      labels = c.value;
    } else if (c.kind === "assignee") {
      if (assignee !== undefined) return null;
      assignee = c.value;
    } else {
      if (state !== undefined) return null;
      state = c.value;
    }
  }
  return {
    ...(labels !== undefined ? { labels } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(state !== undefined ? { state } : {}),
  };
};

/** Best-effort inverse for the editor. Returns null for any shape compileAutoPullRule
 * does not emit (then the editor shows a read-only "advanced rule"). */
export const decodeAutoPullRule = (rule: unknown): AutoPullCriteria | null => {
  // bare true -> empty criteria
  if (rule === true) return {};

  if (typeof rule !== "object" || rule === null) return null;
  const obj = rule as Record<string, unknown>;

  // Top-level `{ and: [...] }` -- split and decode each element
  if ("and" in obj && Array.isArray(obj.and)) {
    // First check if the whole `and` is a label-list (all-of labels single clause)
    const labelValues = decodeLabelList(obj.and as unknown[]);
    if (labelValues !== null) {
      return { labels: { mode: "all", values: labelValues } };
    }
    // Otherwise decode as a compound: each element is a standalone clause
    const clauses: DecodedClause[] = [];
    for (const clause of obj.and as unknown[]) {
      const decoded = decodeClause(clause);
      if (decoded === null) return null;
      clauses.push(decoded);
    }
    return clausesToCriteria(clauses);
  }

  // Single clause
  const decoded = decodeClause(rule);
  if (decoded === null) return null;
  return clausesToCriteria([decoded]);
};

export const summarizeAutoPull = (c: AutoPullCriteria | null): string => {
  if (c === null) return "Manual only";
  const parts: string[] = [];
  if (c.labels && c.labels.values.length > 0) {
    const joined = c.labels.values.join(c.labels.mode === "any" ? " or " : " and ");
    parts.push(`labeled ${joined}`);
  }
  if (c.assignee) {
    parts.push(
      c.assignee.kind === "anyone" ? "assigned to anyone" : `assigned to @${c.assignee.value}`,
    );
  }
  if (c.state) parts.push(c.state);
  return parts.length > 0 ? `Issues ${parts.join(", ")}` : "All issues";
};

// NOTE: `provider` is included in the Pick even though it is not read in the
// body. A Pick of all-optional properties is a "weak type" under TS's
// exactOptionalPropertyTypes, and TypeScript raises TS2559. Adding the required
// `provider` field makes the type non-weak and suppresses the error.
export const effectiveAutoPullRule = (
  source: Pick<WorkflowSourceConfig, "autoPull" | "enabled" | "provider">,
): unknown | null =>
  source.autoPull !== undefined
    ? source.autoPull.rule
    : source.enabled === true
      ? ALWAYS_RULE
      : null;

// PURE selector schemas -- used by synchronous lint AND the providers AND the UI.
export const GithubSelector = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  labels: Schema.optional(Schema.Array(Schema.String)),
  assignee: Schema.optional(Schema.String),
  state: Schema.Literals(["all", "open"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("all" as const)),
  ),
});
export type GithubSelector = typeof GithubSelector.Type;

export const AsanaSelector = Schema.Struct({
  projectGid: TrimmedNonEmptyString,
  sectionGid: Schema.optional(Schema.String),
  tagGid: Schema.optional(Schema.String),
  includeCompleted: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type AsanaSelector = typeof AsanaSelector.Type;

export const JiraSelector = Schema.Struct({
  projectKey: TrimmedNonEmptyString,
  jql: Schema.optional(Schema.String),
});
export type JiraSelector = typeof JiraSelector.Type;

export const WorkSourceConnectionView = Schema.Struct({
  connectionRef: TrimmedNonEmptyString,
  provider: WorkSourceProviderName,
  displayName: TrimmedNonEmptyString,
  authMode: Schema.Literals(["pat", "basic", "bearer"]),
  baseUrl: Schema.NullOr(Schema.String),
});
export type WorkSourceConnectionView = typeof WorkSourceConnectionView.Type;

// -- Import picker schemas -----------------------------------------------------

export const ImportableWorkItemView = Schema.Struct({
  provider: WorkSourceProviderName,
  sourceId: Schema.String,
  externalId: Schema.String,
  displayRef: Schema.String,
  title: Schema.String,
  container: Schema.String,
  url: Schema.String,
  assignees: Schema.Array(Schema.String),
  lifecycle: Schema.Literals(["open", "closed", "deleted"]),
  mappedTicketId: Schema.NullOr(TicketId),
  mappedLane: Schema.NullOr(LaneKey),
});
export type ImportableWorkItemView = typeof ImportableWorkItemView.Type;

export const ImportableSourceSummary = Schema.Struct({
  sourceId: Schema.String,
  provider: WorkSourceProviderName,
  container: Schema.String,
  destinationLane: LaneKey,
});
export type ImportableSourceSummary = typeof ImportableSourceSummary.Type;

export const ListImportableWorkItemsResult = Schema.Struct({
  items: Schema.Array(ImportableWorkItemView),
  sources: Schema.Array(ImportableSourceSummary),
  viewer: Schema.Record(
    Schema.String,
    Schema.NullOr(Schema.Struct({ id: Schema.String, aliases: Schema.Array(Schema.String) })),
  ),
  truncated: Schema.Record(Schema.String, Schema.Boolean),
  sourceErrors: Schema.Record(Schema.String, Schema.String),
});
export type ListImportableWorkItemsResult = typeof ListImportableWorkItemsResult.Type;

export const ImportWorkItemsResult = Schema.Struct({
  imported: Schema.Array(Schema.Struct({ externalId: Schema.String, ticketId: TicketId })),
  skipped: Schema.Array(Schema.Struct({ externalId: Schema.String, reason: Schema.String })),
});
export type ImportWorkItemsResult = typeof ImportWorkItemsResult.Type;
