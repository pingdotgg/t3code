import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  parseDescription,
  runGlobalOp,
  toPhysicalName,
} from "./internal.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_NETWORK_ENDPOINT_TYPE = "INTERNET_FQDN_PORT";

export type GlobalNetworkEndpointType =
  | "INTERNET_FQDN_PORT"
  | "INTERNET_IP_PORT"
  | (string & {});

export type GlobalNetworkEndpointSpec = {
  /** Fully qualified domain name. Required for `INTERNET_FQDN_PORT`. */
  fqdn?: string;
  /** IPv4 address. Required for `INTERNET_IP_PORT`. */
  ipAddress?: string;
  /** IPv6 address. */
  ipv6Address?: string;
  /** Port. Omitted endpoints use the group's `defaultPort`. */
  port?: number;
};

export type GlobalNetworkEndpointGroupProps = {
  /**
   * NEG name (RFC1035, 1–63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the group.
   */
  networkEndpointGroupName?: string;
  /**
   * Optional description. Global internet NEGs have no labels field and
   * no update API, so Alchemy ownership (`alchemy-stack` /
   * `alchemy-stage` / `alchemy-id`) is stored in a `[alchemy …]` prefix
   * for `list` / nuke. Immutable — changing the user-facing description
   * replaces the group.
   */
  description?: string;
  /**
   * Endpoint type. Global NEGs are internet NEGs:
   * `INTERNET_FQDN_PORT` or `INTERNET_IP_PORT`. Immutable — changing
   * it replaces the group.
   * @default "INTERNET_FQDN_PORT"
   */
  networkEndpointType?: GlobalNetworkEndpointType;
  /**
   * Default port used when an endpoint omits `port`. Immutable —
   * changing it replaces the group.
   */
  defaultPort?: number;
  /**
   * User annotations. Immutable — changing them replaces the group.
   */
  annotations?: Record<string, string>;
  /**
   * Member endpoints. A global internet NEG accepts at most one
   * endpoint. When omitted, membership is left as-is. When set
   * (including `[]`), observed endpoints are attached/detached to match.
   */
  networkEndpoints?: GlobalNetworkEndpointSpec[];
};

export type GlobalNetworkEndpointGroup = Resource<
  "GCP.Compute.GlobalNetworkEndpointGroup",
  GlobalNetworkEndpointGroupProps,
  {
    /** NEG name. */
    networkEndpointGroupName: string;
    /** Project id. */
    project: string;
    /** Endpoint type. */
    networkEndpointType: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Default port, if any. */
    defaultPort: number | undefined;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Number of endpoints in the group. */
    size: number | undefined;
    /** Server-assigned numeric id. */
    networkEndpointGroupId: string | undefined;
    /** Resource self-link. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine internet network endpoint group.
 *
 * Global NEGs back internet (`INTERNET_FQDN_PORT` / `INTERNET_IP_PORT`)
 * backends for global external Application Load Balancers. They live in
 * the `global/networkEndpointGroups` collection (zonal VM NEGs and
 * regional serverless/PSC NEGs are separate resources). The collection
 * has no labels field and no update API — Alchemy stamps ownership into
 * the description so `list` / nuke can find leaked groups. Name, type,
 * default port, annotations, and description are immutable (changing any
 * of them replaces the group). Endpoints attach and detach in place.
 *
 * ### Creating a GlobalNetworkEndpointGroup
 * **Example:** FQDN internet NEG
 * ```typescript
 * const neg = yield* GCP.Compute.GlobalNetworkEndpointGroup("Internet", {
 *   networkEndpointType: "INTERNET_FQDN_PORT",
 *   defaultPort: 443,
 * });
 * ```
 *
 * **Example:** Explicit name and a single FQDN endpoint
 * ```typescript
 * const neg = yield* GCP.Compute.GlobalNetworkEndpointGroup("Internet", {
 *   networkEndpointGroupName: "www-neg",
 *   networkEndpointType: "INTERNET_FQDN_PORT",
 *   defaultPort: 443,
 *   networkEndpoints: [{ fqdn: "www.example.com", port: 443 }],
 * });
 * ```
 *
 * ### IP internet NEGs
 * **Example:** Global internet IP:port NEG
 * ```typescript
 * const neg = yield* GCP.Compute.GlobalNetworkEndpointGroup("IpNeg", {
 *   networkEndpointType: "INTERNET_IP_PORT",
 *   defaultPort: 443,
 *   networkEndpoints: [{ ipAddress: "203.0.113.10", port: 443 }],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const GlobalNetworkEndpointGroup = Resource<GlobalNetworkEndpointGroup>(
  "GCP.Compute.GlobalNetworkEndpointGroup",
);

export class GlobalNetworkEndpointGroupNotResolved extends Data.TaggedError(
  "GCP.Compute.GlobalNetworkEndpointGroupNotResolved",
)<{
  networkEndpointGroupName: string;
}> {}

export class GlobalNetworkEndpointGroupStillExists extends Data.TaggedError(
  "GCP.Compute.GlobalNetworkEndpointGroupStillExists",
)<{
  networkEndpointGroupName: string;
}> {}

const annotationsOf = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(annotations);

const sameAnnotations = (
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
) => {
  const a = annotationsOf(left);
  const b = annotationsOf(right);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
};

const asType = (value: string | undefined) =>
  value && value.length > 0 ? value : DEFAULT_NETWORK_ENDPOINT_TYPE;

const toAttrs = (
  group: compute.NetworkEndpointGroup,
  project: string,
): GlobalNetworkEndpointGroup["Attributes"] => {
  const parsed = parseDescription(group.description);
  return {
    networkEndpointGroupName: group.name ?? lastSegment(group.selfLink),
    project,
    networkEndpointType: group.networkEndpointType,
    description: parsed.description,
    defaultPort: group.defaultPort,
    annotations: annotationsOf(group.annotations),
    size: group.size,
    networkEndpointGroupId: group.id,
    selfLink: group.selfLink,
    creationTimestamp: group.creationTimestamp,
    kind: group.kind,
  };
};

const toBody = (
  networkEndpointGroupName: string,
  props: GlobalNetworkEndpointGroupProps,
  ownership: Record<string, string>,
): compute.NetworkEndpointGroup => ({
  name: networkEndpointGroupName,
  description: encodeDescription(ownership, props.description),
  networkEndpointType: asType(props.networkEndpointType),
  defaultPort: props.defaultPort,
  annotations:
    props.annotations !== undefined && Object.keys(props.annotations).length > 0
      ? props.annotations
      : undefined,
});

const toApiEndpoint = (
  endpoint: GlobalNetworkEndpointSpec,
): compute.NetworkEndpoint => ({
  fqdn: endpoint.fqdn,
  ipAddress: endpoint.ipAddress,
  ipv6Address: endpoint.ipv6Address,
  port: endpoint.port,
});

const endpointKey = (endpoint: {
  fqdn?: string;
  ipAddress?: string;
  ipv6Address?: string;
  port?: number;
}) =>
  [
    endpoint.fqdn ?? "",
    endpoint.ipAddress ?? "",
    endpoint.ipv6Address ?? "",
    endpoint.port ?? "",
  ].join("|");

const getByName = (project: string, networkEndpointGroup: string) =>
  compute
    .getGlobalNetworkEndpointGroups({ project, networkEndpointGroup })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, networkEndpointGroupName: string) =>
  getByName(project, networkEndpointGroupName).pipe(
    Effect.flatMap((group) =>
      group !== undefined
        ? Effect.succeed(group)
        : Effect.fail(
            new GlobalNetworkEndpointGroupNotResolved({
              networkEndpointGroupName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.GlobalNetworkEndpointGroupNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (project: string, networkEndpointGroupName: string) =>
  getByName(project, networkEndpointGroupName).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(
            new GlobalNetworkEndpointGroupStillExists({
              networkEndpointGroupName,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.GlobalNetworkEndpointGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.Compute.GlobalNetworkEndpointGroupStillExists",
      () => Effect.void,
    ),
  );

const listEndpoints = (project: string, networkEndpointGroup: string) =>
  compute.listNetworkEndpointsGlobalNetworkEndpointGroups
    .items({
      project,
      networkEndpointGroup,
      maxResults: 500,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk)
          .map((item) => item.networkEndpoint)
          .filter(
            (endpoint): endpoint is compute.NetworkEndpoint =>
              endpoint !== undefined,
          ),
      ),
      Effect.catchTag(["NotFound", "BadRequest"], () =>
        Effect.succeed([] as compute.NetworkEndpoint[]),
      ),
    );

const immutableChanged = (
  news: GlobalNetworkEndpointGroupProps,
  olds: Partial<GlobalNetworkEndpointGroupProps> | undefined,
  output: GlobalNetworkEndpointGroup["Attributes"] | undefined,
) => {
  const previousType = asType(
    olds?.networkEndpointType ?? output?.networkEndpointType,
  );
  if (asType(news.networkEndpointType) !== previousType) return true;

  const previousDescription = olds?.description ?? output?.description ?? "";
  if ((news.description ?? "") !== previousDescription) return true;

  if (
    news.defaultPort !== undefined &&
    news.defaultPort !== (olds?.defaultPort ?? output?.defaultPort)
  ) {
    return true;
  }

  if (
    news.annotations !== undefined &&
    !sameAnnotations(news.annotations, olds?.annotations ?? output?.annotations)
  ) {
    return true;
  }
  return false;
};

export const GlobalNetworkEndpointGroupProvider = () =>
  Provider.succeed(GlobalNetworkEndpointGroup, {
    stables: [
      "networkEndpointGroupName",
      "project",
      "networkEndpointType",
      "networkEndpointGroupId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds.networkEndpointGroupName ?? output?.networkEndpointGroupName;
      const nextName = news.networkEndpointGroupName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;
      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged(news, olds, output)) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkEndpointGroupName = yield* toPhysicalName(
        id,
        olds?.networkEndpointGroupName,
        output?.networkEndpointGroupName,
        "neg",
      );
      const existing = yield* getByName(env.project, networkEndpointGroupName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listGlobalNetworkEndpointGroups
          .items({
            project: env.project,
            maxResults: 500,
            returnPartialSuccess: true,
          })
          .pipe(
            Stream.filter((item) => hasOwnershipMarker(item.description)),
            Stream.map((item) => toAttrs(item, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as GlobalNetworkEndpointGroup["Attributes"][]),
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkEndpointGroupName = yield* toPhysicalName(
        id,
        news.networkEndpointGroupName,
        output?.networkEndpointGroupName,
        "neg",
      );
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(networkEndpointGroupName, news, ownership);

      let current = yield* getByName(env.project, networkEndpointGroupName);

      if (current === undefined) {
        yield* runGlobalOp(
          env.project,
          compute.insertGlobalNetworkEndpointGroups({
            project: env.project,
            body: desired,
          }),
          { ignoreAlreadyExists: true },
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = yield* awaitResource(env.project, networkEndpointGroupName);
      }

      if (current === undefined) {
        return yield* new GlobalNetworkEndpointGroupNotResolved({
          networkEndpointGroupName,
        });
      }

      if (news.networkEndpoints !== undefined) {
        const observed = yield* listEndpoints(
          env.project,
          networkEndpointGroupName,
        );
        const wanted = news.networkEndpoints.map(toApiEndpoint);
        const observedKeys = new Set(observed.map(endpointKey));
        const wantedKeys = new Set(wanted.map(endpointKey));
        const toAdd = wanted.filter(
          (endpoint) => !observedKeys.has(endpointKey(endpoint)),
        );
        const toRemove = observed.filter(
          (endpoint) => !wantedKeys.has(endpointKey(endpoint)),
        );
        if (toAdd.length > 0) {
          yield* runGlobalOp(
            env.project,
            compute.attachNetworkEndpointsGlobalNetworkEndpointGroups({
              project: env.project,
              networkEndpointGroup: networkEndpointGroupName,
              body: { networkEndpoints: toAdd },
            }),
            { ignoreAlreadyExists: true },
          ).pipe(Effect.catchTag(["Conflict", "NotFound"], () => Effect.void));
        }
        if (toRemove.length > 0) {
          yield* runGlobalOp(
            env.project,
            compute.detachNetworkEndpointsGlobalNetworkEndpointGroups({
              project: env.project,
              networkEndpointGroup: networkEndpointGroupName,
              body: { networkEndpoints: toRemove },
            }),
            { ignoreNotFound: true },
          ).pipe(Effect.catchTag(["Conflict", "NotFound"], () => Effect.void));
        }
        current =
          (yield* getByName(env.project, networkEndpointGroupName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      if (!output.networkEndpointGroupName) return;
      yield* runGlobalOp(
        project,
        compute.deleteGlobalNetworkEndpointGroups({
          project,
          networkEndpointGroup: output.networkEndpointGroupName,
        }),
        { ignoreNotFound: true },
      ).pipe(
        Effect.catchTag(["NotFound", "Conflict"], () =>
          Effect.succeed(undefined),
        ),
      );
      yield* waitUntilGone(project, output.networkEndpointGroupName);
    }),
  });
