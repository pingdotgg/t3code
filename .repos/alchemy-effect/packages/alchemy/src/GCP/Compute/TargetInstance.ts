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

export type TargetInstanceNatPolicy = compute.TargetInstanceNatPolicyEnum;

const DEFAULT_ZONE = "us-central1-a";
const DEFAULT_NAT_POLICY: TargetInstanceNatPolicy = "NO_NAT";

export type TargetInstanceProps = {
  /**
   * TargetInstance name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetInstanceName?: string;
  /**
   * Zone the target instance lives in (e.g. `us-central1-a`). Must match
   * the backend VM's zone. Immutable — changing it replaces the resource.
   * When omitted, Alchemy uses the zone from `instance` if that value is a
   * URL, otherwise `us-central1-a`.
   * @default "us-central1-a"
   */
  zone?: string;
  /**
   * Backend VM that terminates traffic. Accepts an instance name, a
   * `projects/{project}/zones/{zone}/instances/{instance}` path, or a
   * self-link. Immutable — changing it replaces the resource.
   */
  instance: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute TargetInstance has
   * no labels field). Immutable — changing it replaces the resource.
   */
  description?: string;
  /**
   * Network used to forward traffic. Accepts a network name
   * (`default`), a partial URL (`global/networks/default`), or a full
   * self-link. When omitted, traffic is forwarded on the VM's default
   * network interface. Immutable — changing it replaces the resource.
   */
  network?: string;
  /**
   * NAT policy applied to forwarded packets. Must be `NO_NAT` — protocol
   * forwarding preserves the destination IP of the forwarding rule.
   * Immutable — changing it replaces the resource.
   * @default "NO_NAT"
   */
  natPolicy?: TargetInstanceNatPolicy | (string & {});
  /**
   * Cloud Armor security policy URL. Updated in place via
   * `setSecurityPolicy`. Pass an empty string to detach.
   */
  securityPolicy?: string;
};

export type TargetInstance = Resource<
  "GCP.Compute.TargetInstance",
  TargetInstanceProps,
  {
    /** TargetInstance name. */
    targetInstanceName: string;
    /** Project id. */
    project: string;
    /** Zone short name (e.g. `us-central1-a`). */
    zone: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** URL of the backend VM. */
    instance: string;
    /** Network URL used for forwarding, if set. */
    network: string | undefined;
    /** NAT policy (`NO_NAT`). */
    natPolicy: string | undefined;
    /** Attached Cloud Armor security policy URL, if any. */
    securityPolicy: string | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    targetInstanceId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal Compute Engine target instance.
 *
 * Target instances terminate protocol-forwarding traffic (ESP, AH, TCP,
 * UDP) for one or more forwarding rules. The backend VM should enable IP
 * forwarding (`canIpForward`). Compute TargetInstance has no labels field —
 * Alchemy ownership is stored in the description so nuke can find leaked
 * resources. Name, zone, instance, network, NAT policy, and description are
 * immutable; only `securityPolicy` updates in place.
 *
 * ### Creating a Target Instance
 * **Example:** Generated name in front of a VM
 * ```typescript
 * const vm = yield* GCP.Compute.Instance("web", {
 *   zone: "us-central1-a",
 *   canIpForward: true,
 * });
 * const target = yield* GCP.Compute.TargetInstance("protocol", {
 *   instance: vm.instanceName,
 *   zone: vm.zone,
 * });
 * ```
 *
 * **Example:** Explicit name, description, and network
 * ```typescript
 * const target = yield* GCP.Compute.TargetInstance("protocol", {
 *   targetInstanceName: "app-protocol",
 *   description: "esp frontend",
 *   instance: vm.selfLink,
 *   zone: "us-central1-a",
 *   network: "default",
 *   natPolicy: "NO_NAT",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const TargetInstance = Resource<TargetInstance>(
  "GCP.Compute.TargetInstance",
);

export class TargetInstanceNotResolved extends Data.TaggedError(
  "GCP.Compute.TargetInstanceNotResolved",
)<{
  targetInstanceName: string;
  zone: string;
}> {}

export class TargetInstanceStillExists extends Data.TaggedError(
  "GCP.Compute.TargetInstanceStillExists",
)<{
  targetInstanceName: string;
  zone: string;
}> {}

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

const zoneFromUrl = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  const parts = value.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf("zones");
  if (index >= 0 && parts[index + 1] !== undefined) {
    return parts[index + 1];
  }
  return undefined;
};

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `t${next}`;
  next = next.slice(0, 63).replace(/-+$/g, "");
  return next.length > 0 ? next : "target";
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

const toInstanceRef = (project: string, zone: string, instance: string) => {
  if (instance.includes("/")) return instance;
  return `projects/${project}/zones/${zone}/instances/${instance}`;
};

const toNetworkRef = (project: string, network: string | undefined) => {
  if (network === undefined || network.length === 0) return undefined;
  if (network.includes("/")) {
    return network.startsWith("projects/") || network.startsWith("http")
      ? network
      : `projects/${project}/${network.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/networks/${network}`;
};

const resolveZone = (
  news: { zone?: string; instance?: string },
  fallback?: string,
) =>
  lastSegment(news.zone) ||
  zoneFromUrl(news.instance) ||
  lastSegment(fallback) ||
  DEFAULT_ZONE;

const toAttrs = (target: compute.TargetInstance, project: string) => {
  const parsed = parseDescription(target.description);
  return {
    targetInstanceName: target.name ?? target.id ?? "",
    project,
    zone: lastSegment(target.zone) || zoneFromUrl(target.selfLink) || "",
    description: parsed.description,
    instance: target.instance ?? "",
    network: target.network,
    natPolicy: target.natPolicy,
    securityPolicy: target.securityPolicy,
    selfLink: target.selfLink,
    targetInstanceId: target.id,
    creationTimestamp: target.creationTimestamp,
    kind: target.kind,
  };
};

const getByName = (project: string, zone: string, targetInstance: string) =>
  compute
    .getTargetInstances({ project, zone, targetInstance })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitTargetGone = (
  project: string,
  zone: string,
  targetInstanceName: string,
) =>
  getByName(project, zone, targetInstanceName).pipe(
    Effect.flatMap((existing) =>
      existing === undefined
        ? Effect.void
        : Effect.fail(
            new TargetInstanceStillExists({ targetInstanceName, zone }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.TargetInstanceStillExists",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const requireTarget = (
  project: string,
  zone: string,
  targetInstanceName: string,
) =>
  getByName(project, zone, targetInstanceName).pipe(
    Effect.flatMap((existing) =>
      existing !== undefined
        ? Effect.succeed(existing)
        : Effect.fail(
            new TargetInstanceNotResolved({ targetInstanceName, zone }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.TargetInstanceNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

export const TargetInstanceProvider = () =>
  Provider.succeed(TargetInstance, {
    stables: [
      "targetInstanceName",
      "project",
      "zone",
      "instance",
      "network",
      "natPolicy",
      "targetInstanceId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.targetInstanceName ?? output?.targetInstanceName;
      const nextName = news.targetInstanceName ?? previousName;
      const previousZone = resolveZone(
        { zone: olds?.zone ?? output?.zone, instance: olds?.instance },
        output?.zone,
      );
      const nextZone = resolveZone(news, previousZone);
      const previousInstance = lastSegment(olds?.instance ?? output?.instance);
      const nextInstance = lastSegment(news.instance);
      const previousNetwork = lastSegment(olds?.network ?? output?.network);
      const nextNetwork =
        news.network !== undefined
          ? lastSegment(news.network)
          : previousNetwork;
      const previousNat =
        olds?.natPolicy ?? output?.natPolicy ?? DEFAULT_NAT_POLICY;
      const nextNat = news.natPolicy ?? DEFAULT_NAT_POLICY;
      const previousDescription =
        olds?.description ?? output?.description ?? "";
      const nextDescription = news.description ?? "";

      const replace =
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName) ||
        previousZone !== nextZone ||
        (previousInstance.length > 0 &&
          nextInstance.length > 0 &&
          previousInstance !== nextInstance) ||
        (news.network !== undefined && previousNetwork !== nextNetwork) ||
        previousNat !== nextNat ||
        previousDescription !== nextDescription;

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousName !== undefined &&
          nextName !== undefined &&
          previousName === nextName,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetInstanceName = yield* toName(
        id,
        olds?.targetInstanceName,
        output?.targetInstanceName,
      );
      const zone = resolveZone(
        { zone: olds?.zone ?? output?.zone, instance: olds?.instance },
        output?.zone,
      );
      const existing = yield* getByName(env.project, zone, targetInstanceName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListTargetInstances
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.targetInstances ?? [])
              .filter((item) => {
                const { labels } = parseDescription(item.description);
                return Object.keys(labels).some((key) =>
                  key.startsWith("alchemy-"),
                );
              })
              .map((item) => toAttrs(item, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetInstanceName = yield* toName(
        id,
        news.targetInstanceName,
        output?.targetInstanceName,
      );
      const zone = resolveZone(news, output?.zone);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredInstance = toInstanceRef(env.project, zone, news.instance);
      const desiredNetwork = toNetworkRef(env.project, news.network);
      const desiredNat = news.natPolicy ?? DEFAULT_NAT_POLICY;

      let current = yield* getByName(env.project, zone, targetInstanceName);

      if (current === undefined) {
        const body: compute.TargetInstance = {
          name: targetInstanceName,
          description: desiredDescription,
          instance: desiredInstance,
          natPolicy: desiredNat,
        };
        if (desiredNetwork !== undefined) {
          body.network = desiredNetwork;
        }
        yield* compute
          .insertTargetInstances({
            project: env.project,
            zone,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitZoneOperation(env.project, zone, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* requireTarget(env.project, zone, targetInstanceName);
      }

      if (current === undefined) {
        return yield* new TargetInstanceNotResolved({
          targetInstanceName,
          zone,
        });
      }

      if (news.securityPolicy !== undefined) {
        const observedPolicy = lastSegment(current.securityPolicy);
        const desiredPolicy = lastSegment(news.securityPolicy);
        if (observedPolicy !== desiredPolicy) {
          yield* compute
            .setSecurityPolicyTargetInstances({
              project: env.project,
              zone,
              targetInstance: targetInstanceName,
              body: { securityPolicy: news.securityPolicy },
            })
            .pipe(
              Effect.flatMap((operation) =>
                waitZoneOperation(env.project, zone, operation),
              ),
            );
          current = yield* requireTarget(env.project, zone, targetInstanceName);
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const zone = lastSegment(output.zone) || DEFAULT_ZONE;
      const operation = yield* compute
        .deleteTargetInstances({
          project: env.project,
          zone,
          targetInstance: output.targetInstanceName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitZoneOperation(env.project, zone, operation, {
          ignore: ["RESOURCE_NOT_FOUND"],
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitTargetGone(env.project, zone, output.targetInstanceName);
    }),
  });
