import type {
  EstimatedUsageResultItem,
  MetricMeasurement,
  MetricTag,
  UsageResultItem,
  WorkspaceResponseCustomerUsageLimit,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { RailwayEnvironment, resolveWorkspace } from "./Environment.ts";

import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export type {
  EstimatedUsageResultItem,
  MetricMeasurement,
  MetricTag,
  UsageResultItem,
};

/**
 * Workspace identity a usage limit applies to. Accepts a
 * `Railway.Project` (`workspaceId`), `{ workspaceId }`, or `{ id }`.
 */
export type UsageLimitWorkspace = {
  readonly workspaceId?: string;
  readonly id?: string;
};

/**
 * Project whose workspace a usage limit applies to. Accepts a
 * `Railway.Project` or a `{ workspaceId, projectId? }` stub.
 */
export type UsageLimitProject = {
  readonly workspaceId: string;
  readonly projectId?: string;
};

/**
 * Dollar cap passed to `usageLimitSet`. A number is the soft limit.
 */
export type UsageLimitAmount = {
  readonly softLimitDollars: number;
  readonly hardLimitDollars?: number;
};

export interface UsageQuery {
  /**
   * Project to query. Accepts a project id, a `Railway.Project`, or a
   * `{ projectId }` stub. Omit for workspace-wide usage.
   */
  project?: string | { readonly projectId: string };
  /**
   * Workspace to query. Accepts a workspace id, `{ workspaceId }` /
   * `{ id }`, or a `Railway.Project`. Defaults to the current token
   * workspace.
   */
  workspace?: string | UsageLimitWorkspace;
  /**
   * Measurements to aggregate (`CPU_USAGE`, `MEMORY_USAGE_GB`, …).
   */
  measurements: ReadonlyArray<MetricMeasurement>;
  /**
   * Inclusive start of the window (RFC3339). Omit for the current
   * billing period of the project owner.
   */
  startDate?: string;
  /**
   * Inclusive end of the window (RFC3339). Omit for now.
   */
  endDate?: string;
  /**
   * Tags to group by (`PROJECT_ID`, `SERVICE_ID`, …). Default is the
   * whole project / workspace.
   */
  groupBy?: ReadonlyArray<MetricTag>;
  /**
   * Include deleted projects in the aggregation.
   *
   * @default false
   */
  includeDeleted?: boolean;
}

export interface EstimatedUsageQuery {
  /**
   * Project to estimate. Accepts a project id, a `Railway.Project`, or a
   * `{ projectId }` stub. Omit for workspace-wide estimates.
   */
  project?: string | { readonly projectId: string };
  /**
   * Workspace to estimate. Defaults to the current token workspace.
   */
  workspace?: string | UsageLimitWorkspace;
  /**
   * Measurements to estimate (`CPU_USAGE`, `MEMORY_USAGE_GB`, …).
   */
  measurements: ReadonlyArray<MetricMeasurement>;
  /**
   * Include deleted projects in the estimate.
   *
   * @default false
   */
  includeDeleted?: boolean;
}

export interface UsageLimitProps {
  /**
   * Workspace whose customer this limit applies to. Accepts a
   * `Railway.Project`, `{ workspaceId }`, or `{ id }`. Defaults to the
   * current token's workspace. Changing it to a different workspace
   * replaces the limit.
   */
  workspace?: Ref<UsageLimitWorkspace>;
  /**
   * Project whose workspace this limit applies to. Alternative to
   * `workspace`. Changing it to a project in a different workspace
   * replaces the limit.
   */
  project?: Ref<UsageLimitProject>;
  /**
   * Dollar cap. A number is `softLimitDollars`. Pass
   * `{ softLimitDollars, hardLimitDollars }` for both. Updates in place
   * via `usageLimitSet`.
   */
  limit: number | UsageLimitAmount;
}

export type UsageLimit = Resource<
  "Railway.UsageLimit",
  UsageLimitProps,
  {
    /** Railway usage-limit id. */
    usageLimitId: string;
    /** Stripe / Railway customer id the cap is set on. */
    customerId: string;
    /** Workspace the customer belongs to. */
    workspaceId: string;
    /** Project used to resolve the workspace, if one was passed. */
    projectId: string | undefined;
    /** Soft dollar cap (`usageLimitSet.softLimitDollars`). */
    softLimitDollars: number;
    /** Hard dollar cap, if set. */
    hardLimitDollars: number | undefined;
    /** Whether current spend is over the soft cap. */
    isOverLimit: boolean;
  },
  never,
  Providers
>;

const projectIdOf = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const workspaceIdOf = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { workspaceId?: unknown; id?: unknown };
  if (typeof rec.workspaceId === "string" && rec.workspaceId.length > 0) {
    return rec.workspaceId;
  }
  if (typeof rec.id === "string" && rec.id.length > 0) {
    return rec.id;
  }
  return undefined;
};

const parseLimit = (limit: number | UsageLimitAmount): UsageLimitAmount => {
  if (typeof limit === "number") {
    return { softLimitDollars: limit };
  }
  return {
    softLimitDollars: limit.softLimitDollars,
    ...(limit.hardLimitDollars !== undefined
      ? { hardLimitDollars: limit.hardLimitDollars }
      : {}),
  };
};

/**
 * Billing usage for a project, workspace, or the current user.
 *
 * Pass `measurements`. Omit `startDate` / `endDate` for the current
 * billing period. Omit `project` for the current workspace.
 *
 * @example Current workspace CPU
 * ```typescript
 * const rows = yield* Railway.usage({
 *   measurements: ["CPU_USAGE"],
 * });
 * ```
 *
 * @example Project window
 * ```typescript
 * const rows = yield* Railway.usage({
 *   project: site,
 *   measurements: ["CPU_USAGE", "MEMORY_USAGE_GB"],
 *   startDate: "2026-01-01T00:00:00.000Z",
 *   endDate: "2026-01-31T23:59:59.000Z",
 * });
 * ```
 */
export const usage = Effect.fn(function* (query: UsageQuery) {
  const projectId = projectIdOf(query.project);
  const workspaceId =
    workspaceIdOf(query.workspace) ?? (yield* resolveWorkspace()).id;
  const rows = yield* railway.usage({
    measurements: [...query.measurements],
    workspaceId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(query.startDate !== undefined ? { startDate: query.startDate } : {}),
    ...(query.endDate !== undefined ? { endDate: query.endDate } : {}),
    ...(query.groupBy !== undefined ? { groupBy: [...query.groupBy] } : {}),
    ...(query.includeDeleted !== undefined
      ? { includeDeleted: query.includeDeleted }
      : {}),
  });
  return rows ?? [];
});

/** Catalog helper. Alias of {@link usage}. */
export const Usage = usage;

/**
 * Estimated total cost at the end of the current billing cycle.
 *
 * @example Workspace estimate
 * ```typescript
 * const rows = yield* Railway.estimatedUsage({
 *   measurements: ["CPU_USAGE"],
 * });
 * ```
 */
export const estimatedUsage = Effect.fn(function* (query: EstimatedUsageQuery) {
  const projectId = projectIdOf(query.project);
  const workspaceId =
    workspaceIdOf(query.workspace) ?? (yield* resolveWorkspace()).id;
  const rows = yield* railway.estimatedUsage({
    measurements: [...query.measurements],
    workspaceId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(query.includeDeleted !== undefined
      ? { includeDeleted: query.includeDeleted }
      : {}),
  });
  return rows ?? [];
});

const resolveUsageLimitProps = (
  props: UsageLimitProps | Effect.Effect<UsageLimitProps, never, Providers>,
): Effect.Effect<UsageLimitProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const workspace =
      resolved.workspace === undefined
        ? undefined
        : Effect.isEffect(resolved.workspace)
          ? yield* resolved.workspace as Effect.Effect<
              UsageLimitWorkspace,
              never,
              Providers
            >
          : resolved.workspace;
    const project =
      resolved.project === undefined
        ? undefined
        : Effect.isEffect(resolved.project)
          ? yield* resolved.project as Effect.Effect<
              UsageLimitProject,
              never,
              Providers
            >
          : resolved.project;
    return { ...resolved, workspace, project };
  });

const UsageLimitResource = Resource<UsageLimit>("Railway.UsageLimit");

/**
 * A Railway.UsageLimit is a soft/hard dollar cap on a workspace
 * customer. One limit per customer. `usageLimitRemove` is idempotent.
 *
 * @see https://docs.railway.com/reference/pricing
 *
 * ### Query usage
 * {@link usage} is a catalog helper — not a resource. It returns
 * aggregated rows for the current workspace (or a project).
 *
 * **Example:** Workspace usage
 * ```typescript
 * const rows = yield* Railway.usage({
 *   measurements: ["CPU_USAGE", "MEMORY_USAGE_GB"],
 * });
 * ```
 *
 * ### Set a limit
 * Omit `workspace` / `project` to cap the current token workspace. A
 * number is the soft dollar cap.
 *
 * **Example:** Soft cap
 * ```typescript
 * const cap = yield* Railway.UsageLimit("SpendCap", {
 *   limit: 50,
 * });
 * ```
 *
 * **Example:** Soft and hard
 * ```typescript
 * const cap = yield* Railway.UsageLimit("SpendCap", {
 *   project: site,
 *   limit: { softLimitDollars: 50, hardLimitDollars: 100 },
 * });
 * ```
 *
 * :::caution[Changing `workspace` or `project` to another workspace replaces the limit]
 * The cap is removed from the old customer, then set on the new one.
 * :::
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope limit
 * ```typescript
 * // src/billing.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const SpendCap = Railway.UsageLimit("SpendCap", {
 *   project: Site,
 *   limit: 50,
 * });
 * ```
 *
 * @resource
 */
export const UsageLimit: typeof UsageLimitResource = Object.assign(
  (
    id: string,
    props: UsageLimitProps | Effect.Effect<UsageLimitProps, never, Providers>,
  ) => UsageLimitResource(id, resolveUsageLimitProps(props)),
  UsageLimitResource,
);

export class UsageLimitNotCreated extends Data.TaggedError(
  "Railway.UsageLimitNotCreated",
)<{
  customerId: string;
  workspaceId: string;
}> {}

export class UsageLimitWorkspaceNotFound extends Data.TaggedError(
  "Railway.UsageLimitWorkspaceNotFound",
)<{
  workspaceId: string;
}> {}

type CloudLimit = WorkspaceResponseCustomerUsageLimit;

const currentWorkspaceId = Effect.fn(function* () {
  const env = yield* yield* RailwayEnvironment;
  return env.workspaceId;
});

const getWorkspace = (workspaceId: string) =>
  railway
    .workspace({ workspaceId })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const toAttrs = (
  limit: CloudLimit,
  fallback: {
    workspaceId: string;
    customerId: string;
    projectId?: string;
  },
): UsageLimit["Attributes"] => ({
  usageLimitId: limit.id,
  customerId: limit.customerId || fallback.customerId,
  workspaceId: fallback.workspaceId,
  projectId: fallback.projectId,
  softLimitDollars: limit.softLimit,
  hardLimitDollars: limit.hardLimit ?? undefined,
  isOverLimit: limit.isOverLimit,
});

const observe = Effect.fn(function* (workspaceId: string) {
  const workspace = yield* getWorkspace(workspaceId);
  if (workspace === undefined) return undefined;
  return {
    workspace,
    customerId: workspace.customer.id,
    limit: workspace.customer.usageLimit ?? undefined,
  };
});

const setLimit = (input: {
  customerId: string;
  softLimitDollars: number;
  hardLimitDollars?: number | null;
}) =>
  railway.usageLimitSet({
    input: {
      customerId: input.customerId,
      softLimitDollars: input.softLimitDollars,
      ...(input.hardLimitDollars !== undefined
        ? { hardLimitDollars: input.hardLimitDollars }
        : {}),
    },
  });

const resolveScope = Effect.fn(function* (input: {
  news?: UsageLimitProps;
  olds?: UsageLimitProps;
  output?: UsageLimit["Attributes"];
}) {
  const projectId =
    projectIdOf(input.news?.project) ??
    input.output?.projectId ??
    projectIdOf(input.olds?.project);
  const workspaceId =
    workspaceIdOf(input.news?.workspace) ??
    workspaceIdOf(input.news?.project) ??
    input.output?.workspaceId ??
    workspaceIdOf(input.olds?.workspace) ??
    workspaceIdOf(input.olds?.project) ??
    (yield* currentWorkspaceId());
  return { workspaceId, projectId };
});

const waitUntilGone = (workspaceId: string, usageLimitId: string) =>
  observe(workspaceId).pipe(
    Effect.map((found) => {
      if (found?.limit === undefined) return true;
      return found.limit.id !== usageLimitId;
    }),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

export const UsageLimitProvider = () =>
  Provider.succeed(UsageLimit, {
    stables: ["usageLimitId", "customerId", "workspaceId"],

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextWorkspace =
        workspaceIdOf(news.workspace) ?? workspaceIdOf(news.project);
      if (nextWorkspace !== undefined && nextWorkspace !== output.workspaceId) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { workspaceId, projectId } = yield* resolveScope({
        olds,
        output,
      });
      const found = yield* observe(workspaceId);
      if (found?.limit === undefined) return undefined;
      return toAttrs(found.limit, {
        workspaceId,
        customerId: found.customerId,
        projectId,
      });
    }),

    list: Effect.fn(function* () {
      const workspaceId = yield* currentWorkspaceId();
      const found = yield* observe(workspaceId);
      if (found?.limit === undefined) return [];
      return [
        toAttrs(found.limit, {
          workspaceId,
          customerId: found.customerId,
        }),
      ];
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const props = news ?? ({} as UsageLimitProps);
      const { workspaceId, projectId } = yield* resolveScope({
        news: props,
        output,
      });
      const desired = parseLimit(props.limit ?? output?.softLimitDollars ?? 0);

      let found = yield* observe(workspaceId);
      if (found === undefined) {
        return yield* new UsageLimitWorkspaceNotFound({ workspaceId });
      }

      const observed = found.limit;
      const hardChanged =
        desired.hardLimitDollars !== undefined
          ? (observed?.hardLimit ?? undefined) !== desired.hardLimitDollars
          : observed?.hardLimit != null;
      const needsSet =
        observed === undefined ||
        observed.softLimit !== desired.softLimitDollars ||
        hardChanged;

      if (needsSet) {
        yield* setLimit({
          customerId: found.customerId,
          softLimitDollars: desired.softLimitDollars,
          ...(desired.hardLimitDollars !== undefined
            ? { hardLimitDollars: desired.hardLimitDollars }
            : observed?.hardLimit != null
              ? { hardLimitDollars: null }
              : {}),
        }).pipe(Effect.catchTag("RailwayValidationError", () => Effect.void));
        found = yield* observe(workspaceId);
      }

      if (found?.limit === undefined) {
        return yield* new UsageLimitNotCreated({
          customerId: found?.customerId ?? output?.customerId ?? "",
          workspaceId,
        });
      }

      return toAttrs(found.limit, {
        workspaceId,
        customerId: found.customerId,
        projectId,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const customerId = output.customerId;
      const workspaceId = output.workspaceId;
      if (customerId.length === 0) return;
      yield* railway
        .usageLimitRemove({ input: { customerId } })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      if (workspaceId.length > 0 && output.usageLimitId.length > 0) {
        yield* waitUntilGone(workspaceId, output.usageLimitId);
      }
    }),
  });
