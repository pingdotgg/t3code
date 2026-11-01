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

export type CrossSiteNetworkProps = {
  /**
   * Cross-site network name (RFC1035, 1-63 chars). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  crossSiteNetworkName?: string;
  /**
   * Optional description. Compute CrossSiteNetwork has no labels field —
   * Alchemy ownership is stored in a `[alchemy …]` prefix for `list` /
   * nuke.
   */
  description?: string;
};

export type CrossSiteNetwork = Resource<
  "GCP.Compute.CrossSiteNetwork",
  CrossSiteNetworkProps,
  {
    /** Cross-site network name. */
    crossSiteNetworkName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Server-assigned numeric id. */
    crossSiteNetworkId: string | undefined;
    /** Server-defined URL. */
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
 * A global Compute Engine cross-site network.
 *
 * Cross-site networks group Wire Groups that connect on-premises and
 * cloud sites through Cross-Cloud Interconnect. The resource itself is a
 * named container — Wire Groups attach later. Compute has no labels
 * field, so Alchemy stamps ownership into the description.
 *
 * ### Creating a Cross-Site Network
 * **Example:** Generated name
 * ```typescript
 * const network = yield* GCP.Compute.CrossSiteNetwork("backbone", {});
 * ```
 *
 * **Example:** Named network with a description
 * ```typescript
 * const network = yield* GCP.Compute.CrossSiteNetwork("backbone", {
 *   crossSiteNetworkName: "prod-backbone",
 *   description: "cross-cloud interconnect fabric",
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const CrossSiteNetwork = Resource<CrossSiteNetwork>(
  "GCP.Compute.CrossSiteNetwork",
);

export class CrossSiteNetworkNotResolved extends Data.TaggedError(
  "GCP.Compute.CrossSiteNetworkNotResolved",
)<{
  crossSiteNetworkName: string;
}> {}

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `c${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "crosssitenetwork";
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

const toAttrs = (
  network: compute.CrossSiteNetwork,
  project: string,
): CrossSiteNetwork["Attributes"] => {
  const parsed = parseDescription(network.description);
  return {
    crossSiteNetworkName: network.name ?? network.id ?? "",
    project,
    description: parsed.description,
    crossSiteNetworkId: network.id,
    selfLink: network.selfLink,
    creationTimestamp: network.creationTimestamp,
    kind: network.kind,
  };
};

const getByName = (project: string, crossSiteNetwork: string) =>
  compute
    .getCrossSiteNetworks({ project, crossSiteNetwork })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, crossSiteNetworkName: string) =>
  getByName(project, crossSiteNetworkName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (network) => network !== undefined,
      times: 8,
    }),
  );

export const CrossSiteNetworkProvider = () =>
  Provider.succeed(CrossSiteNetwork, {
    stables: [
      "crossSiteNetworkName",
      "project",
      "crossSiteNetworkId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.crossSiteNetworkName ?? output?.crossSiteNetworkName;
      const nextName = news.crossSiteNetworkName;
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
      const crossSiteNetworkName = yield* toName(
        id,
        olds?.crossSiteNetworkName,
        output?.crossSiteNetworkName,
      );
      const existing = yield* getByName(env.project, crossSiteNetworkName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listCrossSiteNetworks
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((network) => {
              const { labels } = parseDescription(network.description);
              return Object.keys(labels).some((key) =>
                key.startsWith("alchemy-"),
              );
            }),
            Stream.map((network) => toAttrs(network, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const crossSiteNetworkName = yield* toName(
        id,
        news.crossSiteNetworkName,
        output?.crossSiteNetworkName,
      );
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);

      let current = yield* getByName(env.project, crossSiteNetworkName);

      if (current === undefined) {
        yield* compute
          .insertCrossSiteNetworks({
            project: env.project,
            body: {
              name: crossSiteNetworkName,
              description,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation, {
                ignore: ["RESOURCE_ALREADY_EXISTS"],
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* awaitResource(env.project, crossSiteNetworkName);
      }

      if (current === undefined) {
        return yield* new CrossSiteNetworkNotResolved({
          crossSiteNetworkName,
        });
      }

      if ((current.description ?? "") !== description) {
        yield* compute
          .patchCrossSiteNetworks({
            project: env.project,
            crossSiteNetwork: crossSiteNetworkName,
            updateMask: "description",
            body: {
              name: crossSiteNetworkName,
              description,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, crossSiteNetworkName);
        if (current === undefined) {
          return yield* new CrossSiteNetworkNotResolved({
            crossSiteNetworkName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteCrossSiteNetworks({
          project: env.project,
          crossSiteNetwork: output.crossSiteNetworkName,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            schedule: Schedule.spaced("2 seconds"),
            times: 8,
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
