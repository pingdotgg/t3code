import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitZoneOperation } from "./operations.ts";
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

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_PRIORITY = 1000;
const MAX_NAME_LENGTH = 63;

export type ZoneVmExtensionPolicyExtensionPolicy =
  compute.VmExtensionPolicyExtensionPolicy;
export type ZoneVmExtensionPolicyInstanceSelector =
  compute.VmExtensionPolicyInstanceSelector;
export type ZoneVmExtensionPolicyExtensionPolicyMap =
  compute.VmExtensionPolicyExtensionPolicyMap;

export type ZoneVmExtensionPolicyProps = {
  /**
   * Policy name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing the name
   * replaces the policy.
   */
  vmExtensionPolicyName?: string;
  /**
   * Zone the policy lives in (e.g. `us-central1-a`). Immutable — changing
   * it replaces the policy.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Optional description. Zone VM extension policies have no labels
   * field, so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix for `list` / nuke.
   */
  description?: string;
  /**
   * Policy priority (0-65535, lower is higher priority).
   * @default 1000
   */
  priority?: number;
  /**
   * Selectors that target VMs. A VM matches if it matches any selector.
   * Empty applies the policy to every VM in the zone.
   */
  instanceSelectors?: ReadonlyArray<ZoneVmExtensionPolicyInstanceSelector>;
  /**
   * Map of extension name (`ops-agent`, `google-cloud-sap-extension`,
   * `google-cloud-workload-extension`) to configuration.
   */
  extensionPolicies?: ZoneVmExtensionPolicyExtensionPolicyMap;
};

export type ZoneVmExtensionPolicy = Resource<
  "GCP.Compute.ZoneVmExtensionPolicy",
  ZoneVmExtensionPolicyProps,
  {
    /** Policy name. */
    vmExtensionPolicyName: string;
    /** Server-assigned numeric id. */
    vmExtensionPolicyId: string | undefined;
    /** Project id. */
    project: string;
    /** Zone short name (`us-central1-a`). */
    zone: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Policy priority. */
    priority: number | undefined;
    /** VM selectors. */
    instanceSelectors: ReadonlyArray<ZoneVmExtensionPolicyInstanceSelector>;
    /** Extension configurations. */
    extensionPolicies: ZoneVmExtensionPolicyExtensionPolicyMap | undefined;
    /** Server-reported state (`ACTIVE`, `DELETING`, …). */
    state: string | undefined;
    /** Whether a global policy manages this zonal policy. */
    managedByGlobal: boolean;
    /** Link to the managing global policy, if any. */
    globalResourceLink: string | undefined;
    /** Compute Engine self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine VM extension policy.
 *
 * Zone VM extension policies install Google-provided extensions (Ops
 * Agent, SAP, workload) on VMs that match label selectors. Compute Engine
 * has no labels on this resource, so Alchemy stamps ownership into the
 * description so `list` / `pnpm nuke:gcp` can find them.
 *
 * Name and zone are immutable — changing them replaces the policy.
 * Description, priority, selectors, and extension configurations update
 * in place via `zoneVmExtensionPolicies.patch`.
 *
 * ### Creating a Zone VM Extension Policy
 * **Example:** Install Ops Agent on labeled VMs
 * ```typescript
 * const policy = yield* GCP.Compute.ZoneVmExtensionPolicy("Ops", {
 *   zone: "us-central1-a",
 *   extensionPolicies: {
 *     "ops-agent": { pinnedVersion: "2.58.0" },
 *   },
 *   instanceSelectors: [
 *     { labelSelector: { inclusionLabels: { env: "prod" } } },
 *   ],
 * });
 * ```
 *
 * **Example:** Named policy with a description
 * ```typescript
 * const policy = yield* GCP.Compute.ZoneVmExtensionPolicy("Ops", {
 *   vmExtensionPolicyName: "ops-agent-prod",
 *   description: "ops-agent for prod VMs",
 *   priority: 500,
 *   extensionPolicies: { "ops-agent": {} },
 *   instanceSelectors: [
 *     { labelSelector: { inclusionLabels: { role: "app" } } },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const ZoneVmExtensionPolicy = Resource<ZoneVmExtensionPolicy>(
  "GCP.Compute.ZoneVmExtensionPolicy",
);

export class ZoneVmExtensionPolicyNotResolved extends Data.TaggedError(
  "GCP.Compute.ZoneVmExtensionPolicyNotResolved",
)<{
  vmExtensionPolicyName: string;
  zone: string;
}> {}

export class ZoneVmExtensionPolicyNotReady extends Data.TaggedError(
  "GCP.Compute.ZoneVmExtensionPolicyNotReady",
)<{
  vmExtensionPolicyName: string;
  status: string;
}> {}

export class ZoneVmExtensionPolicyStillExists extends Data.TaggedError(
  "GCP.Compute.ZoneVmExtensionPolicyStillExists",
)<{
  vmExtensionPolicyName: string;
  status: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeZone = (zone: string | undefined) =>
  lastSegment(zone ?? DEFAULT_ZONE).toLowerCase();

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `v${generated}`.slice(0, MAX_NAME_LENGTH);
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

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const defaultExtensions = (): compute.VmExtensionPolicyExtensionPolicyMap => ({
  "ops-agent": {},
});

const toBody = (
  vmExtensionPolicyName: string,
  props: ZoneVmExtensionPolicyProps,
  ownership: Record<string, string>,
): compute.VmExtensionPolicy => ({
  name: vmExtensionPolicyName,
  description: encodeDescription(ownership, props.description),
  priority: props.priority ?? DEFAULT_PRIORITY,
  instanceSelectors: props.instanceSelectors
    ? [...props.instanceSelectors]
    : undefined,
  extensionPolicies: props.extensionPolicies ?? defaultExtensions(),
});

const toAttrs = (
  policy: compute.VmExtensionPolicy,
  project: string,
  zone: string,
): ZoneVmExtensionPolicy["Attributes"] => {
  const parsed = parseDescription(policy.description);
  return {
    vmExtensionPolicyName: policy.name ?? policy.id ?? "",
    vmExtensionPolicyId: policy.id,
    project,
    zone: normalizeZone(zone),
    description: parsed.description,
    priority: policy.priority,
    instanceSelectors: policy.instanceSelectors ?? [],
    extensionPolicies: policy.extensionPolicies,
    state: policy.state,
    managedByGlobal: policy.managedByGlobal === true,
    globalResourceLink: policy.globalResourceLink,
    selfLink: policy.selfLink,
    creationTimestamp: policy.creationTimestamp,
  };
};

const getByName = (project: string, zone: string, vmExtensionPolicy: string) =>
  compute
    .getZoneVmExtensionPolicies({ project, zone, vmExtensionPolicy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitPolicyReady = (
  project: string,
  zone: string,
  vmExtensionPolicyName: string,
) =>
  getByName(project, zone, vmExtensionPolicyName).pipe(
    Effect.filterOrFail(
      (policy): policy is compute.VmExtensionPolicy =>
        policy !== undefined &&
        (policy.state === "ACTIVE" || policy.state === undefined),
      (policy) =>
        new ZoneVmExtensionPolicyNotReady({
          vmExtensionPolicyName,
          status: policy?.state ?? "MISSING",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.ZoneVmExtensionPolicyNotReady",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitPolicyGone = (
  project: string,
  zone: string,
  vmExtensionPolicyName: string,
) =>
  getByName(project, zone, vmExtensionPolicyName).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(
            new ZoneVmExtensionPolicyStillExists({
              vmExtensionPolicyName,
              status: policy.state ?? "UNKNOWN",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof ZoneVmExtensionPolicyStillExists,
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const ZoneVmExtensionPolicyProvider = () =>
  Provider.succeed(ZoneVmExtensionPolicy, {
    stables: [
      "vmExtensionPolicyName",
      "vmExtensionPolicyId",
      "project",
      "zone",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousName =
        olds?.vmExtensionPolicyName ?? output?.vmExtensionPolicyName;
      const nextName = news.vmExtensionPolicyName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;

      const previousZone = normalizeZone(olds?.zone ?? output?.zone);
      const nextZone = normalizeZone(news.zone ?? output?.zone);

      if (nameChanged || previousZone !== nextZone) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            nextName === previousName &&
            previousZone === nextZone,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const vmExtensionPolicyName = yield* toName(
        id,
        olds?.vmExtensionPolicyName,
        output?.vmExtensionPolicyName,
      );
      const zone = normalizeZone(olds?.zone ?? output?.zone);
      const existing = yield* getByName(
        env.project,
        zone,
        vmExtensionPolicyName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, zone);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const zones = yield* compute.listZones
          .items({
            project: env.project,
            maxResults: 500,
          })
          .pipe(
            Stream.filter((zone) => zone.status === "UP" && !!zone.name),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        const pages = yield* Effect.forEach(
          zones,
          (zone) =>
            compute.listZoneVmExtensionPolicies
              .items({
                project: env.project,
                zone: zone.name!,
                maxResults: 500,
                returnPartialSuccess: true,
              })
              .pipe(
                Stream.filter((policy) =>
                  hasOwnershipMarker(policy.description),
                ),
                Stream.map((policy) =>
                  toAttrs(policy, env.project, zone.name!),
                ),
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
                Effect.catchTag("NotFound", () => Effect.succeed([])),
              ),
          { concurrency: 8 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const vmExtensionPolicyName = yield* toName(
        id,
        news.vmExtensionPolicyName,
        output?.vmExtensionPolicyName,
      );
      const zone = normalizeZone(news.zone ?? output?.zone);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(vmExtensionPolicyName, news, ownership);

      let current = yield* getByName(env.project, zone, vmExtensionPolicyName);
      if (current?.state === "DELETING") {
        yield* waitPolicyGone(env.project, zone, vmExtensionPolicyName);
        current = undefined;
      }

      if (current === undefined) {
        const inserted = yield* compute
          .insertZoneVmExtensionPolicies({
            project: env.project,
            zone,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitZoneOperation(env.project, zone, inserted, {
            ignore: ["RESOURCE_ALREADY_EXISTS"],
          });
        }
        current = yield* waitPolicyReady(
          env.project,
          zone,
          vmExtensionPolicyName,
        );
      }

      if (current === undefined) {
        return yield* new ZoneVmExtensionPolicyNotResolved({
          vmExtensionPolicyName,
          zone,
        });
      }

      const descriptionChanged =
        (current.description ?? "") !== (desired.description ?? "");
      const priorityChanged =
        (current.priority ?? DEFAULT_PRIORITY) !==
        (desired.priority ?? DEFAULT_PRIORITY);
      const selectorsChanged = !sameJson(
        current.instanceSelectors ?? [],
        desired.instanceSelectors ?? [],
      );
      const extensionsChanged = !sameJson(
        current.extensionPolicies,
        desired.extensionPolicies,
      );

      if (
        !current.managedByGlobal &&
        (descriptionChanged ||
          priorityChanged ||
          selectorsChanged ||
          extensionsChanged)
      ) {
        const patched = yield* compute.updateZoneVmExtensionPolicies({
          project: env.project,
          zone,
          vmExtensionPolicy: vmExtensionPolicyName,
          body: desired,
        });
        yield* waitZoneOperation(env.project, zone, patched);
        current =
          (yield* getByName(env.project, zone, vmExtensionPolicyName)) ??
          (yield* waitPolicyReady(env.project, zone, vmExtensionPolicyName));
      }

      if (current === undefined) {
        return yield* new ZoneVmExtensionPolicyNotResolved({
          vmExtensionPolicyName,
          zone,
        });
      }

      return toAttrs(current, env.project, zone);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const zone = normalizeZone(output.zone);
      const deleted = yield* compute
        .deleteZoneVmExtensionPolicies({
          project,
          zone,
          vmExtensionPolicy: output.vmExtensionPolicyName,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (deleted !== undefined) {
        yield* waitZoneOperation(project, zone, deleted, {
          ignore: ["RESOURCE_NOT_FOUND"],
        });
      }
      yield* waitPolicyGone(project, zone, output.vmExtensionPolicyName);
    }),
  });
