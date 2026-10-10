import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fromAttributes,
  toAttributes,
  userAttributeList,
  type Attribute,
} from "./ownership.ts";
import {
  lastSegment,
  orgParent,
  resolveOrgId,
  sameJson,
  sortedStrings,
  toPhysicalId,
} from "./operations.ts";

const MAX_NAME_LENGTH = 255;

export type ApiproductProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id. Immutable.
   */
  organizationId?: string;
  /**
   * Internal API product id (`A-Z0-9._-$ %`). If omitted, a unique name
   * is generated. Immutable.
   */
  apiproductId?: string;
  /**
   * Name shown in the UI and developer portal.
   */
  displayName?: string;
  /**
   * Human-readable description shown to portal developers.
   */
  description?: string;
  /**
   * Environments this product is bound to. Empty allows every
   * environment.
   */
  environments?: string[];
  /**
   * API proxy names this product is bound to. Empty allows every proxy.
   */
  proxies?: string[];
  /**
   * API resource paths bundled in the product.
   */
  apiResources?: string[];
  /**
   * How API keys are approved: `auto` or `manual`.
   */
  approvalType?: string;
  /**
   * Request quota (number of messages per interval).
   */
  quota?: string;
  /**
   * Quota interval.
   */
  quotaInterval?: string;
  /**
   * Quota time unit (`minute`, `hour`, `day`, `month`).
   */
  quotaTimeUnit?: string;
  /**
   * OAuth scopes validated at runtime.
   */
  scopes?: string[];
  /**
   * Customer attributes (`public` / `private` / `internal` access, etc.).
   * Alchemy ownership attributes are merged in automatically.
   */
  attributes?: Attribute[];
  /**
   * Parent Space resource id, if any.
   */
  space?: string;
};

export type Apiproduct = Resource<
  "GCP.Apigee.Apiproduct",
  ApiproductProps,
  {
    /** Full resource name `organizations/{org}/apiproducts/{product}`. */
    name: string;
    /** Internal API product id. */
    apiproductId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** Bound environments. */
    environments: string[];
    /** Bound API proxies. */
    proxies: string[];
    /** Bundled API resources. */
    apiResources: string[];
    /** Key approval type. */
    approvalType: string | undefined;
    /** Quota limit. */
    quota: string | undefined;
    /** Quota interval. */
    quotaInterval: string | undefined;
    /** Quota time unit. */
    quotaTimeUnit: string | undefined;
    /** OAuth scopes. */
    scopes: string[];
    /** User attributes (Alchemy ownership attributes stripped). */
    attributes: Attribute[];
    /** Parent Space id, if any. */
    space: string | undefined;
    /** Creation time in milliseconds since epoch. */
    createdAt: string | undefined;
    /** Last modification time in milliseconds since epoch. */
    lastModifiedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee API product — a bundle of proxies, resources, quota, and
 * metadata delivered to developers.
 *
 * Products have no labels field. Alchemy stamps ownership into
 * attributes (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) so
 * `list` / nuke can find them. The internal name
 * is immutable.
 *
 * ### Creating an API Product
 * **Example:** Generated name, auto-approved
 * ```typescript
 * const product = yield* GCP.Apigee.Apiproduct("Public", {
 *   displayName: "Public APIs",
 *   approvalType: "auto",
 * });
 * ```
 *
 * **Example:** Bound to proxies and a quota
 * ```typescript
 * const product = yield* GCP.Apigee.Apiproduct("Orders", {
 *   displayName: "Orders",
 *   environments: ["prod"],
 *   proxies: ["orders-v1"],
 *   approvalType: "auto",
 *   quota: "1000",
 *   quotaInterval: "1",
 *   quotaTimeUnit: "hour",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Apiproduct = Resource<Apiproduct>("GCP.Apigee.Apiproduct");

export class ApiproductNotResolved extends Data.TaggedError(
  "GCP.Apigee.ApiproductNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organizationId: string, apiproductId: string) =>
  `${orgParent(organizationId)}/apiproducts/${apiproductId}`;

const toAttrs = (
  product: apigee.GoogleCloudApigeeV1ApiProduct,
  project: string,
  organizationId: string,
) => {
  const apiproductId = lastSegment(product.name ?? "");
  const attributes = userAttributeList(product.attributes);
  return {
    name: resourceName(organizationId, apiproductId),
    apiproductId,
    organizationId,
    project,
    displayName: product.displayName,
    description: product.description,
    environments: sortedStrings(product.environments),
    proxies: sortedStrings(product.proxies),
    apiResources: sortedStrings(product.apiResources),
    approvalType: product.approvalType,
    quota: product.quota,
    quotaInterval: product.quotaInterval,
    quotaTimeUnit: product.quotaTimeUnit,
    scopes: sortedStrings(product.scopes),
    attributes,
    space: product.space,
    createdAt: product.createdAt,
    lastModifiedAt: product.lastModifiedAt,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsApiproducts({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const toBody = (
  apiproductId: string,
  props: ApiproductProps,
  description: string | undefined,
  attributes: apigee.GoogleCloudApigeeV1Attribute[],
): apigee.GoogleCloudApigeeV1ApiProduct => ({
  name: apiproductId,
  displayName: props.displayName ?? apiproductId,
  description,
  environments: props.environments,
  proxies: props.proxies,
  apiResources: props.apiResources,
  approvalType: props.approvalType,
  quota: props.quota,
  quotaInterval: props.quotaInterval,
  quotaTimeUnit: props.quotaTimeUnit,
  scopes: props.scopes,
  attributes,
  space: props.space,
});

export const ApiproductProvider = () =>
  Provider.succeed(Apiproduct, {
    stables: ["name", "apiproductId", "organizationId", "project", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.apiproductId ?? output?.apiproductId;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      if (
        (previousId !== undefined &&
          news.apiproductId !== undefined &&
          news.apiproductId !== previousId) ||
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
      const apiproductId = yield* toPhysicalId(
        id,
        olds?.apiproductId,
        output?.apiproductId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organizationId, apiproductId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, organizationId);
      const { labels } = fromAttributes(existing.attributes);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organizationId = yield* resolveOrgId(env.project);
        const page = yield* apigee
          .listOrganizationsApiproducts({
            parent: orgParent(organizationId),
            expand: true,
            count: "1000",
          })
          .pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed({ apiProduct: [] }),
            ),
          );
        return (page.apiProduct ?? [])
          .filter(
            (product) =>
              fromAttributes(product.attributes).labels["alchemy-id"] !==
              undefined,
          )
          .map((product) => toAttrs(product, env.project, organizationId));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        news.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const apiproductId = yield* toPhysicalId(
        id,
        news.apiproductId,
        output?.apiproductId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organizationId, apiproductId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = news.description;
      const desiredAttributes = toAttributes(ownership, news.attributes);
      const body = toBody(
        apiproductId,
        news,
        desiredDescription,
        desiredAttributes,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsApiproducts({
            parent: orgParent(organizationId),
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ApiproductNotResolved({ name });
      }

      const needsUpdate =
        (current.displayName ?? "") !== (body.displayName ?? "") ||
        (current.description ?? "") !== (desiredDescription ?? "") ||
        (current.approvalType ?? "") !== (news.approvalType ?? "") ||
        (current.quota ?? "") !== (news.quota ?? "") ||
        (current.quotaInterval ?? "") !== (news.quotaInterval ?? "") ||
        (current.quotaTimeUnit ?? "") !== (news.quotaTimeUnit ?? "") ||
        (current.space ?? "") !== (news.space ?? "") ||
        !sameJson(
          sortedStrings(current.environments),
          sortedStrings(news.environments),
        ) ||
        !sameJson(
          sortedStrings(current.proxies),
          sortedStrings(news.proxies),
        ) ||
        !sameJson(
          sortedStrings(current.apiResources),
          sortedStrings(news.apiResources),
        ) ||
        !sameJson(sortedStrings(current.scopes), sortedStrings(news.scopes)) ||
        !sameJson(current.attributes ?? [], desiredAttributes);

      if (needsUpdate) {
        current = yield* apigee.updateOrganizationsApiproducts({
          name,
          body,
        });
      }

      return toAttrs(current, env.project, organizationId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsApiproducts({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
