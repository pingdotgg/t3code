import * as compute from "@distilled.cloud/gcp/compute_v1";
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
import { waitGlobalOperation } from "./operations.ts";

const DEFAULT_REDUNDANCY_TYPE = "TWO_IPS_REDUNDANCY";
const MAX_NAME_LENGTH = 63;

export type ExternalVpnGatewayInterfaceProps = {
  /**
   * Numeric interface id. `0` for `SINGLE_IP_INTERNALLY_REDUNDANT`,
   * `0` and `1` for `TWO_IPS_REDUNDANCY`, `0`–`3` for
   * `FOUR_IPS_REDUNDANCY`.
   */
  id?: number;
  /**
   * IPv4 address of the peer VPN gateway interface. Must not be a
   * Compute Engine IP. Immutable — changing it replaces the gateway.
   */
  ipAddress?: string;
  /**
   * IPv6 address of the peer VPN gateway interface (RFC 4291). Must
   * not be a Compute Engine IP. Immutable — changing it replaces the
   * gateway.
   */
  ipv6Address?: string;
};

export type ExternalVpnGatewayInterface = {
  /** Numeric interface id. */
  id: number | undefined;
  /** Peer IPv4 address. */
  ipAddress: string | undefined;
  /** Peer IPv6 address, if any. */
  ipv6Address: string | undefined;
};

export type ExternalVpnGatewayProps = {
  /**
   * Gateway name. If omitted, a unique RFC1035 name is generated from
   * the stack, stage, and logical id. Immutable — changing it replaces
   * the gateway.
   */
  externalVpnGatewayName?: string;
  /**
   * Optional description. Immutable — changing it replaces the
   * gateway.
   */
  description?: string;
  /**
   * Peer redundancy. `SINGLE_IP_INTERNALLY_REDUNDANT` (one interface),
   * `TWO_IPS_REDUNDANCY` (two interfaces), or `FOUR_IPS_REDUNDANCY`
   * (four interfaces, typically AWS). Immutable — changing it
   * replaces the gateway.
   * @default "TWO_IPS_REDUNDANCY"
   */
  redundancyType?: compute.ExternalVpnGatewayRedundancyTypeEnum | (string & {});
  /**
   * Peer interfaces. Count must match `redundancyType`. Immutable —
   * changing them replaces the gateway.
   */
  interfaces?: ExternalVpnGatewayInterfaceProps[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and synced via `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
};

export type ExternalVpnGateway = Resource<
  "GCP.Compute.ExternalVpnGateway",
  ExternalVpnGatewayProps,
  {
    /** Gateway name. */
    externalVpnGatewayName: string;
    /** Project id. */
    project: string;
    /** Server-assigned numeric id. */
    externalVpnGatewayId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Peer redundancy type. */
    redundancyType: string | undefined;
    /** Peer interfaces (ids and IPs). */
    interfaces: ReadonlyArray<ExternalVpnGatewayInterface>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine external VPN gateway — the on-premises or
 * other-cloud peer that an HA VPN gateway connects to.
 *
 * Labels are the only in-place update (`externalVpnGateways.setLabels`).
 * Name, description, redundancy type, and interfaces replace the
 * gateway.
 *
 * ### Creating an ExternalVpnGateway
 * **Example:** Generated name with two peer IPs
 * ```typescript
 * const peer = yield* GCP.Compute.ExternalVpnGateway("Peer", {
 *   redundancyType: "TWO_IPS_REDUNDANCY",
 *   interfaces: [
 *     { id: 0, ipAddress: "203.0.113.1" },
 *     { id: 1, ipAddress: "203.0.113.2" },
 *   ],
 * });
 * ```
 *
 * **Example:** Named gateway with labels
 * ```typescript
 * const peer = yield* GCP.Compute.ExternalVpnGateway("Peer", {
 *   externalVpnGatewayName: "onprem-vpn",
 *   description: "on-prem peer",
 *   redundancyType: "SINGLE_IP_INTERNALLY_REDUNDANT",
 *   interfaces: [{ id: 0, ipAddress: "203.0.113.10" }],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const ExternalVpnGateway = Resource<ExternalVpnGateway>(
  "GCP.Compute.ExternalVpnGateway",
);

export class ExternalVpnGatewayNotResolved extends Data.TaggedError(
  "GCP.Compute.ExternalVpnGatewayNotResolved",
)<{
  externalVpnGatewayName: string;
}> {}

export class ExternalVpnGatewayPending extends Data.TaggedError(
  "GCP.Compute.ExternalVpnGatewayPending",
)<{
  externalVpnGatewayName: string;
  status: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const redundancyOf = (
  value: string | undefined,
  interfaces?: ReadonlyArray<unknown>,
) => {
  if (value) return value;
  const n = interfaces?.length ?? 0;
  if (n === 1) return "SINGLE_IP_INTERNALLY_REDUNDANT";
  if (n === 4) return "FOUR_IPS_REDUNDANCY";
  return DEFAULT_REDUNDANCY_TYPE;
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
    const rfc = generated.replace(/^[^a-z]+/, "e").replace(/-+$/g, "");
    return rfc.slice(0, MAX_NAME_LENGTH);
  });

const toInterfaces = (
  interfaces: compute.ExternalVpnGatewayInterfaceList | undefined,
): ExternalVpnGatewayInterface[] =>
  (interfaces ?? []).map((iface) => ({
    id: iface.id,
    ipAddress: iface.ipAddress,
    ipv6Address: iface.ipv6Address,
  }));

const interfaceKey = (
  interfaces: ReadonlyArray<{
    id?: number;
    ipAddress?: string;
    ipv6Address?: string;
  }>,
) =>
  interfaces
    .map(
      (iface) =>
        `${iface.id ?? ""}:${iface.ipAddress ?? ""}:${iface.ipv6Address ?? ""}`,
    )
    .sort()
    .join("|");

const toAttrs = (gateway: compute.ExternalVpnGateway, project: string) => ({
  externalVpnGatewayName: gateway.name ?? "",
  project,
  externalVpnGatewayId: gateway.id,
  selfLink: gateway.selfLink,
  description: gateway.description,
  redundancyType: gateway.redundancyType,
  interfaces: toInterfaces(gateway.interfaces),
  labels: userLabels(gateway.labels),
  creationTimestamp: gateway.creationTimestamp,
});

const getByName = (project: string, externalVpnGateway: string) =>
  compute
    .getExternalVpnGateways({ project, externalVpnGateway })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const requireGateway = (project: string, externalVpnGatewayName: string) =>
  getByName(project, externalVpnGatewayName).pipe(
    Effect.flatMap((gateway) =>
      gateway
        ? Effect.succeed(gateway)
        : Effect.fail(
            new ExternalVpnGatewayNotResolved({ externalVpnGatewayName }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.ExternalVpnGatewayNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilGone = (project: string, externalVpnGatewayName: string) =>
  getByName(project, externalVpnGatewayName).pipe(
    Effect.flatMap((gateway) =>
      gateway === undefined
        ? Effect.void
        : Effect.fail(
            new ExternalVpnGatewayPending({
              externalVpnGatewayName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.ExternalVpnGatewayPending",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const ExternalVpnGatewayProvider = () =>
  Provider.succeed(ExternalVpnGateway, {
    stables: [
      "externalVpnGatewayName",
      "project",
      "externalVpnGatewayId",
      "selfLink",
      "redundancyType",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds.externalVpnGatewayName ?? output?.externalVpnGatewayName;
      const nextName = news.externalVpnGatewayName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousDescription = olds.description ?? output?.description ?? "";
      const previousRedundancy = redundancyOf(
        olds.redundancyType ?? output?.redundancyType,
        olds.interfaces ?? output?.interfaces,
      );
      const previousInterfaces = interfaceKey(
        output?.interfaces ?? olds.interfaces ?? [],
      );

      const immutableChanged =
        (news.description !== undefined &&
          (news.description ?? "") !== previousDescription) ||
        (news.redundancyType !== undefined &&
          redundancyOf(news.redundancyType, news.interfaces) !==
            previousRedundancy) ||
        (news.interfaces !== undefined &&
          interfaceKey(news.interfaces) !== previousInterfaces);

      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const externalVpnGatewayName = yield* toName(
        id,
        olds?.externalVpnGatewayName,
        output?.externalVpnGatewayName,
      );
      const existing = yield* getByName(env.project, externalVpnGatewayName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listExternalVpnGateways
          .items({
            project: env.project,
            filter: "labels.alchemy-id:*",
            maxResults: 500,
          })
          .pipe(
            Stream.filter((gateway) =>
              Object.keys(gateway.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((gateway) => toAttrs(gateway, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const externalVpnGatewayName = yield* toName(
        id,
        news.externalVpnGatewayName,
        output?.externalVpnGatewayName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, externalVpnGatewayName);

      if (current === undefined) {
        const body: compute.ExternalVpnGateway = {
          name: externalVpnGatewayName,
          description: news.description,
          redundancyType: redundancyOf(news.redundancyType, news.interfaces),
        };
        if (news.interfaces !== undefined && news.interfaces.length > 0) {
          body.interfaces = news.interfaces.map((iface) => ({
            id: iface.id,
            ipAddress: iface.ipAddress,
            ipv6Address: iface.ipv6Address,
          }));
        }
        const created = yield* compute
          .insertExternalVpnGateways({
            project: env.project,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }).pipe(
                Effect.flatMap(() =>
                  requireGateway(env.project, externalVpnGatewayName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, externalVpnGatewayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ExternalVpnGatewayNotResolved({
          externalVpnGatewayName,
        });
      }

      const resolved = current;
      const observedLabels = tagRecord(resolved.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(env.project, externalVpnGatewayName)) ?? resolved;
          yield* compute
            .setLabelsExternalVpnGateways({
              project: env.project,
              resource: externalVpnGatewayName,
              body: {
                labels: desiredLabels,
                labelFingerprint: latest.labelFingerprint,
              },
            })
            .pipe(
              Effect.flatMap((operation) =>
                waitGlobalOperation(env.project, operation),
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
          (yield* getByName(env.project, externalVpnGatewayName)) ?? resolved;
      }

      return toAttrs(current ?? resolved, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      if (!output.externalVpnGatewayName) return;
      yield* compute
        .deleteExternalVpnGateways({
          project,
          externalVpnGateway: output.externalVpnGatewayName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitGlobalOperation(project, operation, {
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
      yield* waitUntilGone(project, output.externalVpnGatewayName);
    }),
  });
