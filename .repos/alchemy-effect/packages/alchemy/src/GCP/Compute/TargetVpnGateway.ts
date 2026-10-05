import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;

export type TargetVpnGatewayProps = {
  /**
   * Gateway name. If omitted, a unique RFC1035 name is generated from
   * the stack, stage, and logical id. Immutable — changing it replaces
   * the gateway.
   */
  targetVpnGatewayName?: string;
  /**
   * Region the Classic VPN gateway lives in. Immutable — changing it
   * replaces the gateway. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * VPC network this gateway is attached to. Accepts a name
   * (`default`), a partial URL (`global/networks/default`), or a full
   * resource URL. Immutable — changing it replaces the gateway.
   */
  network: string;
  /**
   * Optional description. Immutable — changing it replaces the
   * gateway.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type TargetVpnGateway = Resource<
  "GCP.Compute.TargetVpnGateway",
  TargetVpnGatewayProps,
  {
    /** Gateway name. */
    targetVpnGatewayName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Network URL. */
    network: string | undefined;
    /** Server-assigned numeric id. */
    targetVpnGatewayId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Description. */
    description: string | undefined;
    /** `CREATING`, `READY`, `FAILED`, or `DELETING`. */
    status: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** URLs of VpnTunnel resources attached to this gateway. */
    tunnels: ReadonlyArray<string>;
    /** URLs of ForwardingRule resources attached to this gateway. */
    forwardingRules: ReadonlyArray<string>;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine Classic VPN gateway (`targetVpnGateway`).
 *
 * Classic VPN attaches a single gateway to a VPC in one region. Prefer
 * HA VPN (`VpnGateway`) for new deployments. Labels are the only
 * in-place update (`targetVpnGateways.setLabels`); name, region,
 * network, and description replace the gateway.
 *
 * ### Creating a TargetVpnGateway
 * **Example:** Generated name on a custom VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const gateway = yield* GCP.Compute.TargetVpnGateway("Gateway", {
 *   network: network.networkName,
 * });
 * ```
 *
 * **Example:** Named gateway with labels
 * ```typescript
 * const gateway = yield* GCP.Compute.TargetVpnGateway("Gateway", {
 *   targetVpnGatewayName: "app-classic-vpn",
 *   region: "us-central1",
 *   network: "default",
 *   description: "classic vpn",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const TargetVpnGateway = Resource<TargetVpnGateway>(
  "GCP.Compute.TargetVpnGateway",
);

export class TargetVpnGatewayNotResolved extends Data.TaggedError(
  "GCP.Compute.TargetVpnGatewayNotResolved",
)<{
  targetVpnGatewayName: string;
  region: string;
}> {}

export class TargetVpnGatewayPending extends Data.TaggedError(
  "GCP.Compute.TargetVpnGatewayPending",
)<{
  targetVpnGatewayName: string;
  status: string;
}> {}

export class TargetVpnGatewayOperationFailed extends Data.TaggedError(
  "GCP.Compute.TargetVpnGatewayOperationFailed",
)<{
  targetVpnGatewayName: string;
  operation: string;
  message: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const resourceRefOf = (value: string | undefined) => {
  if (!value) return "";
  return lastSegment(value);
};

const networkUrl = (project: string, network: string) => {
  if (network.includes("/")) {
    return network.startsWith("projects/") || network.startsWith("http")
      ? network
      : `projects/${project}/${network.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/networks/${network}`;
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const rfc = generated.replace(/^[^a-z]+/, "t").replace(/-+$/g, "");
    return rfc.slice(0, MAX_NAME_LENGTH);
  });

const toAttrs = (gateway: compute.TargetVpnGateway, project: string) => ({
  targetVpnGatewayName: gateway.name ?? "",
  project,
  region: lastSegment(gateway.region ?? "").toLowerCase(),
  network: gateway.network,
  targetVpnGatewayId: gateway.id,
  selfLink: gateway.selfLink,
  description: gateway.description,
  status: gateway.status,
  labels: userLabels(gateway.labels),
  tunnels: gateway.tunnels ?? [],
  forwardingRules: gateway.forwardingRules ?? [],
  creationTimestamp: gateway.creationTimestamp,
});

const getByName = (project: string, region: string, targetVpnGateway: string) =>
  compute
    .getTargetVpnGateways({ project, region, targetVpnGateway })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireGateway = (
  project: string,
  region: string,
  targetVpnGatewayName: string,
) =>
  Effect.gen(function* () {
    const gateway = yield* getByName(project, region, targetVpnGatewayName);
    if (gateway === undefined) {
      return yield* new TargetVpnGatewayNotResolved({
        targetVpnGatewayName,
        region,
      });
    }
    if (gateway.status === "FAILED") {
      return yield* new TargetVpnGatewayOperationFailed({
        targetVpnGatewayName,
        operation: "insert",
        message: "target VPN gateway status is FAILED",
      });
    }
    if (gateway.status !== undefined && gateway.status !== "READY") {
      return yield* new TargetVpnGatewayPending({
        targetVpnGatewayName,
        status: gateway.status,
      });
    }
    return gateway;
  }).pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "GCP.Compute.TargetVpnGatewayNotResolved" ||
        e._tag === "GCP.Compute.TargetVpnGatewayPending",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (
  project: string,
  region: string,
  targetVpnGatewayName: string,
) =>
  getByName(project, region, targetVpnGatewayName).pipe(
    Effect.flatMap((gateway) =>
      gateway === undefined
        ? Effect.void
        : Effect.fail(
            new TargetVpnGatewayPending({
              targetVpnGatewayName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.TargetVpnGatewayPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const TargetVpnGatewayProvider = () =>
  Provider.succeed(TargetVpnGateway, {
    nuke: {
      dependsOn: ["GCP.Compute.Network"],
    },
    stables: [
      "targetVpnGatewayName",
      "project",
      "region",
      "network",
      "targetVpnGatewayId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds.targetVpnGatewayName ?? output?.targetVpnGatewayName;
      const nextName = news.targetVpnGatewayName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousRegion = normalizeRegion(
        olds.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;

      const previousNetwork = resourceRefOf(olds.network ?? output?.network);
      const nextNetwork = resourceRefOf(news.network);
      const previousDescription = olds.description ?? output?.description ?? "";

      const immutableChanged =
        nextNetwork !== previousNetwork ||
        (news.description !== undefined &&
          (news.description ?? "") !== previousDescription);

      if (nameChanged || regionChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetVpnGatewayName = yield* toName(
        id,
        olds?.targetVpnGatewayName,
        output?.targetVpnGatewayName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        targetVpnGatewayName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListTargetVpnGateways
          .pages({
            project: env.project,
            filter: "labels.alchemy-id:*",
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.targetVpnGateways ?? [])
              .filter((gateway) =>
                Object.keys(gateway.labels ?? {}).some((key) =>
                  key.startsWith("alchemy-"),
                ),
              )
              .map((gateway) => toAttrs(gateway, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetVpnGatewayName = yield* toName(
        id,
        news.targetVpnGatewayName,
        output?.targetVpnGatewayName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, region, targetVpnGatewayName);

      if (current === undefined) {
        const created = yield* compute
          .insertTargetVpnGateways({
            project: env.project,
            region,
            body: {
              name: targetVpnGatewayName,
              network: networkUrl(env.project, news.network),
              description: news.description,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requireGateway(env.project, region, targetVpnGatewayName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, region, targetVpnGatewayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TargetVpnGatewayNotResolved({
          targetVpnGatewayName,
          region,
        });
      }

      const resolved = current;
      const observedLabels = tagRecord(resolved.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(env.project, region, targetVpnGatewayName)) ??
            resolved;
          yield* compute
            .setLabelsTargetVpnGateways({
              project: env.project,
              region,
              resource: targetVpnGatewayName,
              body: {
                labels: desiredLabels,
                labelFingerprint: latest.labelFingerprint,
              },
            })
            .pipe(
              Effect.flatMap((operation) =>
                waitRegionOperation(env.project, region, operation),
              ),
            );
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 5,
            schedule: Schedule.spaced("1 second"),
          }),
        );
        current =
          (yield* getByName(env.project, region, targetVpnGatewayName)) ??
          resolved;
      }

      return toAttrs(current ?? resolved, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region, env.region);
      if (!output.targetVpnGatewayName) return;
      yield* compute
        .deleteTargetVpnGateways({
          project,
          region,
          targetVpnGateway: output.targetVpnGatewayName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitRegionOperation(project, region, operation, {
              ignore: ["RESOURCE_NOT_FOUND"],
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(project, region, output.targetVpnGatewayName);
    }),
  });
