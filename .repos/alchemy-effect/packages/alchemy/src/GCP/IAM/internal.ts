import * as iam from "@distilled.cloud/gcp/iam_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  sanitizeLabelValue,
  toLabels,
} from "../Labels.ts";
import {
  waitForOperation as waitForLongRunning,
  type LongRunningOperation,
} from "../Operation.ts";

export const MAX_POLICY_ID = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.IAM.ResourceNotResolved",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const attachmentPointOf = (
  project: string,
  attachmentPoint?: string,
) => {
  if (attachmentPoint && attachmentPoint.length > 0) {
    return attachmentPoint.includes("%2F")
      ? attachmentPoint
      : encodeURIComponent(attachmentPoint);
  }
  return encodeURIComponent(
    `cloudresourcemanager.googleapis.com/projects/${project}`,
  );
};

export const denypoliciesParent = (attachmentPoint: string) =>
  `policies/${attachmentPoint}/denypolicies`;

export const policyName = (attachmentPoint: string, policyId: string) =>
  `${denypoliciesParent(attachmentPoint)}/${policyId}`;

export const parsePolicyName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const policiesAt = parts.indexOf("policies");
  const denyAt = parts.lastIndexOf("denypolicies");
  return {
    attachmentPoint:
      policiesAt >= 0 && parts[policiesAt + 1] ? parts[policiesAt + 1]! : "",
    policyId:
      denyAt >= 0 && parts[denyAt + 1] ? parts[denyAt + 1]! : lastSegment(name),
  };
};

const rfc1035 = (value: string) => {
  let next = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `p${next}`;
  next = next.slice(0, MAX_POLICY_ID).replace(/-+$/g, "");
  if (next.length < 3) next = `${next}xxx`.slice(0, MAX_POLICY_ID);
  return next;
};

export const toPolicyId = (
  id: string,
  requested: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return rfc1035(requested);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_POLICY_ID,
        lowercase: true,
      }),
    );
  });

export const ownershipAnnotations = (id: string) =>
  Effect.gen(function* () {
    return toLabels(yield* createInternalLabels(id));
  });

export const hasOwnershipAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
) => Object.keys(annotations ?? {}).some((key) => key.startsWith("alchemy-"));

export const ownedByAlchemy = (
  id: string,
  annotations: Record<string, string | undefined> | null | undefined,
) =>
  hasAlchemyLabels(
    id,
    Object.fromEntries(
      Object.entries(annotations ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );

export const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(annotations ?? {}).filter(
      ([key, value]) =>
        !key.startsWith("alchemy-") && typeof value === "string",
    ),
  ) as Record<string, string>;

export { alchemyLabelKeys, sanitizeLabelValue };

/** Deny policy operations finish within seconds. */
const OPERATION_BUDGET = "5 minutes";

/**
 * Wait for a long-running operation. ALREADY_EXISTS (code 6) means a
 * concurrent create won the race; reconcile observes the resource next.
 */
export const waitForOperation = (operation: LongRunningOperation) =>
  waitForLongRunning(operation, (name) => iam.getPoliciesOperations({ name }), {
    budget: OPERATION_BUDGET,
  }).pipe(
    Effect.catchIf(
      (error) => error._tag === "GCP.OperationFailed" && error.code === 6,
      () => Effect.succeed(operation),
    ),
  );

/**
 * Wait for a delete operation. A vanished operation or NOT_FOUND (code 5)
 * means the resource is already gone.
 */
export const waitForDeleteOperation = (operation: LongRunningOperation) =>
  waitForOperation(operation).pipe(
    Effect.catchIf(
      (error) =>
        error._tag === "NotFound" ||
        (error._tag === "GCP.OperationFailed" && error.code === 5),
      () => Effect.succeed(operation),
    ),
  );
