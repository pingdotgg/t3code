import * as billingbudgets from "@distilled.cloud/gcp/billingbudgets_v1";
import * as cloudbilling from "@distilled.cloud/gcp/cloudbilling_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { createPhysicalName } from "../../PhysicalName.ts";

export const MAX_DISPLAY_NAME_LENGTH = 60;

export class BillingAccountNotResolved extends Data.TaggedError(
  "GCP.BillingBudgets.BillingAccountNotResolved",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const billingAccountIdOf = (value: string) => lastSegment(value);

export const billingAccountParent = (billingAccountId: string) =>
  billingAccountId.startsWith("billingAccounts/")
    ? billingAccountId
    : `billingAccounts/${billingAccountId}`;

export const budgetNameOf = (billingAccountId: string, budgetId: string) =>
  `${billingAccountParent(billingAccountId)}/budgets/${budgetId}`;

export const parseBudgetName = (
  name: string,
  fallbackAccount = "",
): { billingAccountId: string; budgetId: string } => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const accountsAt = parts.indexOf("billingAccounts");
  const budgetsAt = parts.indexOf("budgets");
  return {
    billingAccountId:
      accountsAt >= 0 && parts[accountsAt + 1]
        ? parts[accountsAt + 1]!
        : fallbackAccount,
    budgetId:
      budgetsAt >= 0 && parts[budgetsAt + 1]
        ? parts[budgetsAt + 1]!
        : lastSegment(name),
  };
};

/** The display name Alchemy generates for a logical id when none is given. */
export const generatedDisplayName = (id: string) =>
  createPhysicalName({
    id,
    maxLength: 20,
    lowercase: true,
  });

export const lookupProjectBillingAccountId = (project: string) =>
  cloudbilling.getBillingInfoProjects({ name: `projects/${project}` }).pipe(
    Effect.map((info) =>
      info.billingAccountName
        ? billingAccountIdOf(info.billingAccountName)
        : undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const resolveBillingAccountId = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return billingAccountIdOf(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return billingAccountIdOf(existing);
    }
    const env = yield* GcpEnvironment.current;
    const resolved = yield* lookupProjectBillingAccountId(env.project);
    if (resolved === undefined) {
      return yield* new BillingAccountNotResolved({ project: env.project });
    }
    return resolved;
  });

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const toProjectNumberRef = (value: string) => {
  const id = lastSegment(value);
  if (/^\d+$/.test(id)) return Effect.succeed(`projects/${id}`);
  return resourcemanager.getProjects({ name: `projects/${id}` }).pipe(
    Effect.map((project) => project.name ?? `projects/${id}`),
    Effect.catchTag("NotFound", () => Effect.succeed(`projects/${id}`)),
  );
};

export const resolveProjectRefs = (projects: readonly string[] | undefined) =>
  projects === undefined
    ? Effect.succeed(undefined as string[] | undefined)
    : Effect.forEach(projects, toProjectNumberRef);

export const filterChanged = (
  observed: Record<string, unknown> | undefined,
  desired: Record<string, unknown> | undefined,
) => {
  if (desired === undefined) return false;
  const left = observed ?? {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    if (!jsonEqual(left[key], value)) return true;
  }
  return false;
};

export const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

export const projectScope = (project: string) =>
  project.startsWith("projects/") ? project : `projects/${project}`;

export const getBudget = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : billingbudgets.getBillingAccountsBudgets({ name }).pipe(
        // Missing budgets return 403 "The caller does not have permission"
        // rather than 404 (typed as BudgetNotFound).
        Effect.catchTag(["NotFound", "BudgetNotFound"], () =>
          Effect.succeed(undefined),
        ),
      );

export const listBudgets = (parent: string, scope?: string) =>
  parent.length === 0
    ? Effect.succeed([] as billingbudgets.GoogleCloudBillingBudgetsV1Budget[])
    : billingbudgets.listBillingAccountsBudgets
        .pages({
          parent,
          pageSize: 100,
          scope,
        })
        .pipe(
          Stream.take(10),
          Stream.flatMap((page) => Stream.fromIterable(page.budgets ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            Effect.succeed(
              [] as billingbudgets.GoogleCloudBillingBudgetsV1Budget[],
            ),
          ),
        );

export const findBudgetByDisplayName = (parent: string, displayName: string) =>
  Effect.gen(function* () {
    const env = yield* GcpEnvironment.current;
    const budgets = yield* listBudgets(parent, projectScope(env.project));
    return budgets.find((budget) => budget.displayName === displayName);
  });
