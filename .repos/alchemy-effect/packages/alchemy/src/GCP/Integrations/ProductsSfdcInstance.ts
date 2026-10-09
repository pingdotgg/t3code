import * as integrations from "@distilled.cloud/gcp/integrations_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_PRODUCT,
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  locationOf,
  normalizeLocation,
  normalizeProduct,
  ownedByAlchemy,
  parseOwnership,
  productOf,
  productParent,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type ProductsSfdcInstanceProps = {
  /**
   * Salesforce instance id (the `{sfdcInstance}` segment). Server-assigned
   * on create. Immutable — changing it replaces the instance.
   */
  sfdcInstanceId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * instance. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Product id (`IP` for Application Integration, `APIGEE` for Apigee
   * Integration). Immutable — changing it replaces the instance.
   * @default "IP"
   */
  product?: string;
  /**
   * Unique display name / alias.
   */
  displayName?: string;
  /**
   * Human-readable description. Salesforce instances have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
  /**
   * Salesforce org id.
   */
  sfdcOrgId?: string;
  /**
   * Auth config ids tried when opening a channel to Salesforce.
   */
  authConfigId?: string[];
  /**
   * URL used for API calls after authentication.
   */
  serviceAuthority?: string;
};

export type ProductsSfdcInstance = Resource<
  "GCP.Integrations.ProductsSfdcInstance",
  ProductsSfdcInstanceProps,
  {
    /** Full resource name. */
    name: string;
    /** Salesforce instance id (last path segment). */
    sfdcInstanceId: string;
    /** Location id. */
    location: string;
    /** Product id. */
    product: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Salesforce org id. */
    sfdcOrgId: string | undefined;
    /** Auth config ids. */
    authConfigId: string[] | undefined;
    /** Service authority URL. */
    serviceAuthority: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A product-scoped Salesforce instance used by Application Integration
 * (`projects/.../products/{product}/sfdcInstances/{sfdcInstance}`).
 *
 * Instances have no labels field — Alchemy stamps ownership into the
 * description. Location, product, and id are immutable. Display name,
 * description, org id, auth configs, and service authority update in
 * place.
 *
 * ### Creating a Salesforce Instance
 * **Example:** Named org
 * ```typescript
 * const sfdc = yield* GCP.Integrations.ProductsSfdcInstance("ProdOrg", {
 *   product: "IP",
 *   displayName: "prod-org",
 *   sfdcOrgId: "00D000000000001",
 *   serviceAuthority: "https://example.my.salesforce.com",
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const ProductsSfdcInstance = Resource<ProductsSfdcInstance>(
  "GCP.Integrations.ProductsSfdcInstance",
);

export class ProductsSfdcInstanceNotResolved extends Data.TaggedError(
  "GCP.Integrations.ProductsSfdcInstanceNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  product: string,
  sfdcInstanceId: string,
) =>
  `${productParent(project, location, product)}/sfdcInstances/${sfdcInstanceId}`;

const toAttrs = (
  instance: integrations.GoogleCloudIntegrationsV1alphaSfdcInstance,
  project: string,
  region: string,
) => {
  const name = instance.name ?? "";
  const parsed = parseOwnership(instance.description);
  return {
    name,
    sfdcInstanceId: lastSegment(name),
    location: locationOf(name, region),
    product: productOf(name),
    project,
    displayName: instance.displayName,
    description: parsed.text,
    sfdcOrgId: instance.sfdcOrgId,
    authConfigId: instance.authConfigId,
    serviceAuthority: instance.serviceAuthority,
    createTime: instance.createTime,
    updateTime: instance.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations
        .getProjectsLocationsProductsSfdcInstances({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  integrations.listProjectsLocationsProductsSfdcInstances
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sfdcInstances ?? [])),
      Stream.filter((instance) => hasOwnershipMarker(instance.description)),
      Stream.map((instance) => toAttrs(instance, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  integrations.listProjectsLocationsProductsSfdcInstances
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sfdcInstances ?? [])),
      Stream.filterEffect((instance) =>
        ownedByAlchemy(id, instance.description),
      ),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const ProductsSfdcInstanceProvider = () =>
  Provider.succeed(ProductsSfdcInstance, {
    stables: [
      "name",
      "sfdcInstanceId",
      "location",
      "product",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = normalizeLocation(
        news.location,
        previousLocation ?? env.region,
      );
      if (
        previousLocation !== undefined &&
        normalizeLocation(previousLocation, env.region) !== nextLocation
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousProduct = olds?.product ?? output?.product;
      const nextProduct = normalizeProduct(news.product);
      if (
        previousProduct !== undefined &&
        normalizeProduct(previousProduct) !== nextProduct
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.sfdcInstanceId ?? output?.sfdcInstanceId;
      if (
        previousId !== undefined &&
        news.sfdcInstanceId !== undefined &&
        news.sfdcInstanceId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sfdcInstanceId = yield* toResourceId(
        id,
        olds?.sfdcInstanceId,
        output?.sfdcInstanceId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const product = normalizeProduct(olds?.product ?? output?.product);
      const name =
        output?.name ??
        resourceName(env.project, location, product, sfdcInstanceId);
      let existing = yield* getByName(name);
      if (existing === undefined && output?.name === undefined) {
        existing = yield* findOwned(
          productParent(env.project, location, product),
          id,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          productParent(env.project, env.region, DEFAULT_PRODUCT),
          env.project,
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const product = normalizeProduct(
        news.product ?? output?.product ?? DEFAULT_PRODUCT,
      );
      const parent = productParent(env.project, location, product);
      const sfdcInstanceId = yield* toResourceId(
        id,
        news.sfdcInstanceId,
        output?.sfdcInstanceId,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, product, sfdcInstanceId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? sfdcInstanceId;

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findOwned(parent, id);
      }

      if (current === undefined) {
        const created = yield* integrations
          .createProjectsLocationsProductsSfdcInstances({
            parent,
            body: {
              displayName,
              description,
              sfdcOrgId: news.sfdcOrgId,
              authConfigId: news.authConfigId,
              serviceAuthority: news.serviceAuthority,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(parent, id)));
        current = created ?? (yield* findOwned(parent, id));
      }

      if (current === undefined) {
        return yield* new ProductsSfdcInstanceNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const orgChanged = !sameText(current.sfdcOrgId, news.sfdcOrgId);
      const authorityChanged = !sameText(
        current.serviceAuthority,
        news.serviceAuthority,
      );
      const authChanged =
        JSON.stringify(current.authConfigId ?? null) !==
        JSON.stringify(news.authConfigId ?? null);

      if (
        displayChanged ||
        descriptionChanged ||
        orgChanged ||
        authorityChanged ||
        authChanged
      ) {
        current =
          yield* integrations.patchProjectsLocationsProductsSfdcInstances({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              orgChanged ? "sfdc_org_id" : undefined,
              authorityChanged ? "service_authority" : undefined,
              authChanged ? "auth_config_id" : undefined,
            ),
            body: {
              name: currentName,
              displayName,
              description,
              sfdcOrgId: news.sfdcOrgId,
              authConfigId: news.authConfigId,
              serviceAuthority: news.serviceAuthority,
            },
          });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsProductsSfdcInstances({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
