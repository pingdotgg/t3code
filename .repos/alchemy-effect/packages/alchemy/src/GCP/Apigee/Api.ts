import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import {
  lastSegment,
  orgParent,
  resolveOrgId,
  toPhysicalId,
} from "./operations.ts";

const MAX_NAME_LENGTH = 255;

export type ApiProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id. Immutable.
   */
  organizationId?: string;
  /**
   * API proxy id (`A-Za-z0-9._-`). If omitted, a unique name is
   * generated. Immutable.
   */
  apiId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Parent Space resource id. Only applied on create.
   */
  space?: string;
};

export type Api = Resource<
  "GCP.Apigee.Api",
  ApiProps,
  {
    /** Full resource name `organizations/{org}/apis/{api}`. */
    name: string;
    /** API proxy id. */
    apiId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Parent Space id, if any. */
    space: string | undefined;
    /** Latest revision id. */
    latestRevisionId: string | undefined;
    /** Defined revisions. */
    revision: string[];
    /** API proxy type. */
    apiProxyType: string | undefined;
    /** Whether the proxy is read-only (archive-generated). */
    readOnly: boolean;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee API proxy. The proxy is not serving traffic until a revision
 * is deployed to an environment.
 *
 * Labels (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) stamp
 * ownership so `list` / nuke can find proxies. Changing `apiId` or
 * `organizationId` replaces the proxy.
 *
 * ### Creating a Proxy
 * **Example:** Generated name
 * ```typescript
 * const proxy = yield* GCP.Apigee.Api("Orders", {});
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const proxy = yield* GCP.Apigee.Api("Orders", {
 *   apiId: "orders-v1",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Api = Resource<Api>("GCP.Apigee.Api");

export class ApiNotResolved extends Data.TaggedError(
  "GCP.Apigee.ApiNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organizationId: string, apiId: string) =>
  `${orgParent(organizationId)}/apis/${apiId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toAttrs = (
  proxy: apigee.GoogleCloudApigeeV1ApiProxy,
  project: string,
  organizationId: string,
) => {
  const apiId = lastSegment(proxy.name ?? "");
  return {
    name: resourceName(organizationId, apiId),
    apiId,
    organizationId,
    project,
    labels: userLabels(proxy.labels),
    space: proxy.space,
    latestRevisionId: proxy.latestRevisionId,
    revision: [...(proxy.revision ?? [])],
    apiProxyType: proxy.apiProxyType,
    readOnly: proxy.readOnly === true,
    createdAt: proxy.metaData?.createdAt,
    lastModifiedAt: proxy.metaData?.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsApis({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

export const ApiProvider = () =>
  Provider.succeed(Api, {
    stables: ["name", "apiId", "organizationId", "project", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.apiId ?? output?.apiId;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      if (
        (previousId !== undefined &&
          news.apiId !== undefined &&
          news.apiId !== previousId) ||
        (previousOrg !== undefined &&
          news.organizationId !== undefined &&
          news.organizationId !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        olds?.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const apiId = yield* toPhysicalId(
        id,
        olds?.apiId,
        output?.apiId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organizationId, apiId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, organizationId);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organizationId = yield* resolveOrgId(env.project);
        const page = yield* apigee
          .listOrganizationsApis({
            parent: orgParent(organizationId),
            includeMetaData: true,
          })
          .pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed({ proxies: [] }),
            ),
          );
        return (page.proxies ?? [])
          .filter((proxy) =>
            Object.keys(proxy.labels ?? {}).some((key) =>
              key.startsWith("alchemy-"),
            ),
          )
          .map((proxy) => toAttrs(proxy, env.project, organizationId));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        news.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const apiId = yield* toPhysicalId(
        id,
        news.apiId,
        output?.apiId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organizationId, apiId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        yield* apigee
          .createOrganizationsApis({
            parent: orgParent(organizationId),
            name: apiId,
            space: news.space,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new ApiNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      if (labelsChanged) {
        current = yield* apigee.patchOrganizationsApis({
          name,
          updateMask: "labels",
          body: {
            labels: desiredLabels,
          },
        });
      }

      return toAttrs(current, env.project, organizationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsApis({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
