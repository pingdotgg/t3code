import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type GlobalVmExtensionPolicyExtensionPolicy =
  compute.GlobalVmExtensionPolicyExtensionPolicy;
export type GlobalVmExtensionPolicyInstanceSelector =
  compute.GlobalVmExtensionPolicyInstanceSelector;
export type GlobalVmExtensionPolicyRolloutOperation =
  compute.GlobalVmExtensionPolicyRolloutOperation;

export type GlobalVmExtensionPolicyProps = {
  /**
   * Policy name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the policy.
   */
  policyName?: string;
  /**
   * Optional description. Global VM extension policies have no labels
   * field — Alchemy ownership is stored in a `[alchemy …]` prefix for
   * `list` / nuke.
   */
  description?: string;
  /**
   * Map of extension name (e.g. `"ops-agent"`) to policy configuration.
   * Required by the API.
   */
  extensionPolicies?: compute.GlobalVmExtensionPolicyExtensionPolicyMap;
  /**
   * Rollout plan. Defaults to a fast project-wide rollout.
   */
  rolloutOperation?: GlobalVmExtensionPolicyRolloutOperation;
  /**
   * Conflict-resolution priority. Larger numbers win.
   * @default 0
   */
  priority?: number;
  /**
   * VM selectors. Empty applies the policy to every VM. Selectors are
   * AND'd together.
   */
  instanceSelectors?: GlobalVmExtensionPolicyInstanceSelector[];
};

export type GlobalVmExtensionPolicy = Resource<
  "GCP.Compute.GlobalVmExtensionPolicy",
  GlobalVmExtensionPolicyProps,
  {
    /** Policy name. */
    policyName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Extension policy map. */
    extensionPolicies: compute.GlobalVmExtensionPolicyExtensionPolicyMap;
    /** Rollout operation. */
    rolloutOperation: GlobalVmExtensionPolicyRolloutOperation | undefined;
    /** Priority. */
    priority: number | undefined;
    /** VM selectors. */
    instanceSelectors: GlobalVmExtensionPolicyInstanceSelector[];
    /** Server-assigned numeric id. */
    policyId: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** RFC3339 update timestamp. */
    updateTimestamp: string | undefined;
    /** Scoped resource purge status. */
    scopedResourceStatus: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-level Compute Engine VM extension policy.
 *
 * Global policies roll out guest extensions (Ops Agent, and similar) to
 * matching VMs. Name replaces the resource; description, priority,
 * selectors, extensions, and the rollout plan update in place. Compute
 * has no labels field, so Alchemy stamps ownership into the description.
 *
 * ### Creating a Global VM Extension Policy
 * **Example:** Ops Agent, fast rollout
 * ```typescript
 * const policy = yield* GCP.Compute.GlobalVmExtensionPolicy("ops", {
 *   extensionPolicies: { "ops-agent": {} },
 *   rolloutOperation: {
 *     rolloutInput: { predefinedRolloutPlan: "FAST_ROLLOUT" },
 *   },
 * });
 * ```
 *
 * **Example:** Label-selected VMs
 * ```typescript
 * const policy = yield* GCP.Compute.GlobalVmExtensionPolicy("ops", {
 *   extensionPolicies: { "ops-agent": { pinnedVersion: "2.53.0" } },
 *   instanceSelectors: [
 *     { labelSelector: { inclusionLabels: { role: "web" } } },
 *   ],
 *   priority: 100,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const GlobalVmExtensionPolicy = Resource<GlobalVmExtensionPolicy>(
  "GCP.Compute.GlobalVmExtensionPolicy",
);

export class GlobalVmExtensionPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.GlobalVmExtensionPolicyNotResolved",
)<{
  policyName: string;
}> {}

export class GlobalVmExtensionPolicyStillExists extends Data.TaggedError(
  "GCP.Compute.GlobalVmExtensionPolicyStillExists",
)<{
  policyName: string;
}> {}

const DEFAULT_ROLLOUT: GlobalVmExtensionPolicyRolloutOperation = {
  rolloutInput: { predefinedRolloutPlan: "FAST_ROLLOUT" },
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `v${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "vmextensionpolicy";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const jsonOf = (value: unknown) => JSON.stringify(value ?? null);

// Compute echoes unset extension fields back as empty strings
// (`{ pinnedVersion: "", stringConfig: "" }`), so compare only set fields.
const extensionPoliciesKey = (
  policies: compute.GlobalVmExtensionPolicy["extensionPolicies"],
) =>
  jsonOf(
    Object.entries(policies ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, policy]) => [
        name,
        Object.entries(policy ?? {})
          .filter(([, value]) => value !== "" && value != null)
          .sort(([a], [b]) => a.localeCompare(b)),
      ]),
  );

const toBody = (
  policyName: string,
  props: GlobalVmExtensionPolicyProps,
  ownership: Record<string, string>,
): compute.GlobalVmExtensionPolicy => ({
  name: policyName,
  description: encodeDescription(ownership, props.description),
  extensionPolicies: props.extensionPolicies ?? { "ops-agent": {} },
  rolloutOperation: props.rolloutOperation ?? DEFAULT_ROLLOUT,
  priority: props.priority,
  instanceSelectors: props.instanceSelectors,
});

const toAttrs = (
  policy: compute.GlobalVmExtensionPolicy,
  project: string,
): GlobalVmExtensionPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    policyName: policy.name ?? policy.id ?? "",
    project,
    description: parsed.description,
    extensionPolicies: policy.extensionPolicies ?? {},
    rolloutOperation: policy.rolloutOperation,
    priority: policy.priority,
    instanceSelectors: policy.instanceSelectors ?? [],
    policyId: policy.id,
    selfLink: policy.selfLink,
    creationTimestamp: policy.creationTimestamp,
    updateTimestamp: policy.updateTimestamp,
    scopedResourceStatus: policy.scopedResourceStatus,
  };
};

const needsUpdate = (
  current: compute.GlobalVmExtensionPolicy,
  desired: compute.GlobalVmExtensionPolicy,
) => {
  if ((current.description ?? "") !== (desired.description ?? "")) return true;
  if ((current.priority ?? 0) !== (desired.priority ?? 0)) return true;
  if (
    extensionPoliciesKey(current.extensionPolicies) !==
    extensionPoliciesKey(desired.extensionPolicies)
  ) {
    return true;
  }
  if (
    jsonOf(current.instanceSelectors ?? []) !==
    jsonOf(desired.instanceSelectors ?? [])
  ) {
    return true;
  }
  const currentPlan =
    current.rolloutOperation?.rolloutInput?.predefinedRolloutPlan;
  const desiredPlan =
    desired.rolloutOperation?.rolloutInput?.predefinedRolloutPlan;
  return (currentPlan ?? "") !== (desiredPlan ?? "");
};

const getByName = (project: string, globalVmExtensionPolicy: string) =>
  compute
    .getGlobalVmExtensionPolicies({ project, globalVmExtensionPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, policyName: string) =>
  getByName(project, policyName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (item) => item !== undefined,
      times: 8,
    }),
  );

export const GlobalVmExtensionPolicyProvider = () =>
  Provider.succeed(GlobalVmExtensionPolicy, {
    stables: [
      "policyName",
      "project",
      "policyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.policyName ?? output?.policyName;
      const nextName = news.policyName;
      if (
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const policyName = yield* toName(
        id,
        olds?.policyName,
        output?.policyName,
      );
      const existing = yield* getByName(env.project, policyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listGlobalVmExtensionPolicies
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((policy) => {
              const { labels } = parseDescription(policy.description);
              return Object.keys(labels).some((key) =>
                key.startsWith("alchemy-"),
              );
            }),
            Stream.map((policy) => toAttrs(policy, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const policyName = yield* toName(id, news.policyName, output?.policyName);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(policyName, news, ownership);

      let current = yield* getByName(env.project, policyName);

      if (current === undefined) {
        yield* compute
          .insertGlobalVmExtensionPolicies({
            project: env.project,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(env.project, policyName);
      }

      if (current === undefined) {
        return yield* new GlobalVmExtensionPolicyNotResolved({ policyName });
      }

      if (needsUpdate(current, desired)) {
        yield* compute
          .updateGlobalVmExtensionPolicies({
            project: env.project,
            globalVmExtensionPolicy: policyName,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, policyName);
        if (current === undefined) {
          return yield* new GlobalVmExtensionPolicyNotResolved({
            policyName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const requestDelete = (retryUuid?: string) =>
        compute
          .deleteGlobalVmExtensionPolicies({
            project: env.project,
            globalVmExtensionPolicy: output.policyName,
            body: { predefinedRolloutPlan: "FAST_ROLLOUT", retryUuid },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              schedule: Schedule.spaced("2 seconds"),
              times: 8,
            }),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            Effect.flatMap((operation) =>
              operation === undefined
                ? Effect.void
                : waitGlobalOperation(env.project, operation).pipe(
                    Effect.catchTag("NotFound", () => Effect.void),
                    Effect.asVoid,
                  ),
            ),
          );
      // A policy left in DELETING by an earlier (possibly failed) delete
      // rollout only accepts another delete with a fresh `retryUuid`.
      const observed = yield* getByName(env.project, output.policyName);
      if (observed === undefined) return;
      const retryUuid =
        observed.scopedResourceStatus === "SCOPED_RESOURCE_STATUS_DELETING"
          ? yield* Effect.sync(() => crypto.randomUUID())
          : undefined;
      yield* requestDelete(retryUuid);
      // Deletion is itself a rollout; the policy stays readable until the
      // rollout finishes.
      yield* getByName(env.project, output.policyName).pipe(
        Effect.filterOrFail(
          (policy) => policy === undefined,
          () =>
            new GlobalVmExtensionPolicyStillExists({
              policyName: output.policyName,
            }),
        ),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.Compute.GlobalVmExtensionPolicyStillExists",
          schedule: Schedule.spaced("5 seconds"),
          times: 60,
        }),
      );
    }),
  });
