import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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

export type RegionNotificationEndpointGrpcSettings = {
  /**
   * gRPCLB DNS name of the notification service
   * (e.g. `example.googleapis.com` or `health.example.com:443`).
   */
  endpoint: string;
  /**
   * Seconds spent retrying notifications until a successful response.
   * Default 30, max 1200.
   */
  retryDurationSec?: number;
  /**
   * Optional value written to the gRPC `name` field.
   */
  payloadName?: string;
  /**
   * Optional authority header sent with notifications.
   */
  authority?: string;
  /**
   * How often to resend a full update of unhealthy backends (600–3600s).
   * Regional endpoints only.
   */
  resendInterval?: compute.Duration;
};

export type RegionNotificationEndpointProps = {
  /**
   * Endpoint name (RFC1035, 1-63 characters). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  notificationEndpointName?: string;
  /**
   * Region the endpoint lives in (e.g. `us-central1`). Immutable —
   * changing it replaces the resource. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  region?: string;
  /**
   * Optional description. Compute NotificationEndpoint has no labels
   * field and no update API, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and any description change replaces the
   * endpoint.
   */
  description?: string;
  /**
   * gRPC notification settings. Immutable — changing any field replaces
   * the endpoint.
   */
  grpcSettings: RegionNotificationEndpointGrpcSettings;
};

export type RegionNotificationEndpoint = Resource<
  "GCP.Compute.RegionNotificationEndpoint",
  RegionNotificationEndpointProps,
  {
    /** NotificationEndpoint name. */
    notificationEndpointName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** gRPC endpoint DNS name. */
    grpcEndpoint: string | undefined;
    /** Retry duration in seconds. */
    retryDurationSec: number | undefined;
    /** Optional gRPC payload name. */
    payloadName: string | undefined;
    /** Optional authority header. */
    authority: string | undefined;
    /** Full-update resend interval, if set. */
    resendInterval: compute.Duration | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    notificationEndpointId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Compute Engine notification endpoint.
 *
 * Notification endpoints receive gRPC callbacks when a health-check
 * service detects backend status changes. This resource maps to the
 * `regionNotificationEndpoints` collection. There is no update API and
 * no labels field — Alchemy stamps ownership into the description so
 * nuke can find leaked endpoints. Changing any user-facing field
 * replaces the resource.
 *
 * ### Creating a Notification Endpoint
 * **Example:** Generated name
 * ```typescript
 * const endpoint = yield* GCP.Compute.RegionNotificationEndpoint("Health", {
 *   region: "us-central1",
 *   grpcSettings: { endpoint: "health.example.com:443" },
 * });
 * ```
 *
 * **Example:** Named endpoint with retry settings
 * ```typescript
 * const endpoint = yield* GCP.Compute.RegionNotificationEndpoint("Health", {
 *   notificationEndpointName: "app-health",
 *   region: "us-central1",
 *   description: "regional health callbacks",
 *   grpcSettings: {
 *     endpoint: "health.example.com:443",
 *     retryDurationSec: 30,
 *   },
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const RegionNotificationEndpoint = Resource<RegionNotificationEndpoint>(
  "GCP.Compute.RegionNotificationEndpoint",
);

export class RegionNotificationEndpointNotResolved extends Data.TaggedError(
  "GCP.Compute.RegionNotificationEndpointNotResolved",
)<{
  notificationEndpointName: string;
  region: string;
}> {}

const lastSegment = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined, defaultRegion: string) =>
  lastSegment(region ?? defaultRegion).toLowerCase();

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `n${generated}`.slice(0, 63);
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

const sameInterval = (
  left: compute.Duration | undefined,
  right: compute.Duration | undefined,
) =>
  (left?.seconds ?? "") === (right?.seconds ?? "") &&
  (left?.nanos ?? 0) === (right?.nanos ?? 0);

const toAttrs = (endpoint: compute.NotificationEndpoint, project: string) => {
  const parsed = parseDescription(endpoint.description);
  return {
    notificationEndpointName: endpoint.name ?? endpoint.id ?? "",
    project,
    region: lastSegment(endpoint.region).toLowerCase(),
    description: parsed.description,
    grpcEndpoint: endpoint.grpcSettings?.endpoint,
    retryDurationSec: endpoint.grpcSettings?.retryDurationSec,
    payloadName: endpoint.grpcSettings?.payloadName,
    authority: endpoint.grpcSettings?.authority,
    resendInterval: endpoint.grpcSettings?.resendInterval,
    selfLink: endpoint.selfLink,
    notificationEndpointId: endpoint.id,
    creationTimestamp: endpoint.creationTimestamp,
    kind: endpoint.kind,
  };
};

const getByName = (
  project: string,
  region: string,
  notificationEndpoint: string,
) =>
  compute
    .getRegionNotificationEndpoints({
      project,
      region,
      notificationEndpoint,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const immutableChanged = (
  news: RegionNotificationEndpointProps,
  olds: RegionNotificationEndpointProps | undefined,
  output: RegionNotificationEndpoint["Attributes"] | undefined,
) => {
  const previousDescription = olds?.description ?? output?.description ?? "";
  if ((news.description ?? "") !== previousDescription) return true;
  const previousEndpoint =
    olds?.grpcSettings.endpoint ?? output?.grpcEndpoint ?? "";
  if (news.grpcSettings.endpoint !== previousEndpoint) return true;
  const previousRetry =
    olds?.grpcSettings.retryDurationSec ?? output?.retryDurationSec;
  if (
    news.grpcSettings.retryDurationSec !== undefined &&
    news.grpcSettings.retryDurationSec !== previousRetry
  ) {
    return true;
  }
  const previousPayload =
    olds?.grpcSettings.payloadName ?? output?.payloadName ?? "";
  if ((news.grpcSettings.payloadName ?? "") !== previousPayload) return true;
  const previousAuthority =
    olds?.grpcSettings.authority ?? output?.authority ?? "";
  if ((news.grpcSettings.authority ?? "") !== previousAuthority) return true;
  if (
    news.grpcSettings.resendInterval !== undefined &&
    !sameInterval(
      news.grpcSettings.resendInterval,
      olds?.grpcSettings.resendInterval ?? output?.resendInterval,
    )
  ) {
    return true;
  }
  return false;
};

export const RegionNotificationEndpointProvider = () =>
  Provider.succeed(RegionNotificationEndpoint, {
    stables: [
      "notificationEndpointName",
      "project",
      "region",
      "notificationEndpointId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousName =
        olds?.notificationEndpointName ?? output?.notificationEndpointName;
      const nextName = news.notificationEndpointName ?? previousName;
      const previousRegion = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeRegion(
        news.region ?? output?.region,
        env.region,
      );
      const regionChanged = previousRegion !== nextRegion;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        previousName !== nextName;
      if (
        nameChanged ||
        regionChanged ||
        immutableChanged(news, olds, output)
      ) {
        return {
          action: "replace" as const,
          deleteFirst: !regionChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const notificationEndpointName = yield* toName(
        id,
        olds?.notificationEndpointName,
        output?.notificationEndpointName,
      );
      const region = normalizeRegion(
        olds?.region ?? output?.region,
        env.region,
      );
      const existing = yield* getByName(
        env.project,
        region,
        notificationEndpointName,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* compute.aggregatedListRegionNotificationEndpoints
          .pages({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          Object.values(page.items ?? {}).flatMap((scoped) =>
            (scoped?.resources ?? [])
              .filter((endpoint) => hasOwnershipMarker(endpoint.description))
              .map((endpoint) => toAttrs(endpoint, env.project)),
          ),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const notificationEndpointName = yield* toName(
        id,
        news.notificationEndpointName,
        output?.notificationEndpointName,
      );
      const region = normalizeRegion(news.region ?? output?.region, env.region);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* getByName(
        env.project,
        region,
        notificationEndpointName,
      );

      if (current === undefined) {
        const grpcSettings: compute.NotificationEndpointGrpcSettings = {
          endpoint: news.grpcSettings.endpoint,
        };
        if (news.grpcSettings.retryDurationSec !== undefined) {
          grpcSettings.retryDurationSec = news.grpcSettings.retryDurationSec;
        }
        if (news.grpcSettings.payloadName !== undefined) {
          grpcSettings.payloadName = news.grpcSettings.payloadName;
        }
        if (news.grpcSettings.authority !== undefined) {
          grpcSettings.authority = news.grpcSettings.authority;
        }
        if (news.grpcSettings.resendInterval !== undefined) {
          grpcSettings.resendInterval = news.grpcSettings.resendInterval;
        }
        yield* compute
          .insertRegionNotificationEndpoints({
            project: env.project,
            region,
            body: {
              name: notificationEndpointName,
              description: desiredDescription,
              grpcSettings,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitRegionOperation(env.project, region, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(
          env.project,
          region,
          notificationEndpointName,
        );
      }

      if (current === undefined) {
        return yield* new RegionNotificationEndpointNotResolved({
          notificationEndpointName,
          region,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeRegion(output.region, env.region);
      const operation = yield* compute
        .deleteRegionNotificationEndpoints({
          project: env.project,
          region,
          notificationEndpoint: output.notificationEndpointName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitRegionOperation(env.project, region, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
