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
  locationParent,
  normalizeLocation,
  normalizeProduct,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  productOf,
  productParent,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";
import type { TriggerConfig } from "./shared.ts";

export type ProductsIntegrationsVersionProps = {
  /**
   * Integration id (the `{integration}` segment). If omitted, a unique
   * id is generated. Immutable — changing it replaces the version.
   */
  integrationId?: string;
  /**
   * Version id (the `{version}` segment). Server-assigned on create.
   * Immutable — changing it replaces the version.
   */
  versionId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * version. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Product id (`IP` for Application Integration, `APIGEE` for Apigee
   * Integration). Immutable — changing it replaces the version.
   * @default "IP"
   */
  product?: string;
  /**
   * Human-readable description. Integration versions have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  description?: string;
  /**
   * User-defined label that annotates this version.
   */
  userLabel?: string;
  /**
   * Trigger configurations.
   */
  triggerConfigs?: TriggerConfig[];
  /**
   * When true, create a new integration if `integrationId` does not
   * exist. Ignored on update.
   * @default true
   */
  newIntegration?: boolean;
};

export type ProductsIntegrationsVersion = Resource<
  "GCP.Integrations.ProductsIntegrationsVersion",
  ProductsIntegrationsVersionProps,
  {
    /** Full resource name. */
    name: string;
    /** Version id (last path segment). */
    versionId: string;
    /** Parent integration id. */
    integrationId: string;
    /** Parent integration resource name. */
    integration: string;
    /** Location id. */
    location: string;
    /** Product id. */
    product: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** User-defined version label. */
    userLabel: string | undefined;
    /** Trigger configurations. */
    triggerConfigs: TriggerConfig[] | undefined;
    /** Server-reported status (`DRAFT`, `ACTIVE`, …). */
    status: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Snapshot number. */
    snapshotNumber: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A product-scoped Application Integration version
 * (`projects/.../products/{product}/integrations/{integration}/versions/{version}`).
 *
 * Versions have no labels field — Alchemy stamps ownership into the
 * description. Location, product, integration id, and version id are
 * immutable. Description, user label, and trigger configs update in
 * place.
 *
 * ### Creating a Product Version
 * **Example:** Empty draft
 * ```typescript
 * const version = yield* GCP.Integrations.ProductsIntegrationsVersion("Orders", {
 *   product: "IP",
 *   description: "order workflow",
 *   triggerConfigs: [
 *     {
 *       label: "API Trigger",
 *       triggerType: "API",
 *       triggerNumber: "1",
 *       triggerId: "api_trigger/orders",
 *       properties: { "Trigger name": "orders" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const ProductsIntegrationsVersion =
  Resource<ProductsIntegrationsVersion>(
    "GCP.Integrations.ProductsIntegrationsVersion",
  );

export class ProductsIntegrationsVersionNotResolved extends Data.TaggedError(
  "GCP.Integrations.ProductsIntegrationsVersionNotResolved",
)<{
  name: string;
}> {}

const integrationOf = (name: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("integrations");
  return index >= 0 ? parts.slice(0, index + 2).join("/") : parentOf(name);
};

const integrationIdOf = (name: string) => {
  const parts = name.split("/");
  const index = parts.indexOf("integrations");
  return index >= 0
    ? (parts[index + 1] ?? lastSegment(name))
    : lastSegment(name);
};

const resourceName = (
  project: string,
  location: string,
  product: string,
  integrationId: string,
  versionId: string,
) =>
  `${productParent(project, location, product)}/integrations/${integrationId}/versions/${versionId}`;

const triggersOf = (
  configs:
    | integrations.GoogleCloudIntegrationsV1alphaTriggerConfigList
    | undefined,
): TriggerConfig[] | undefined => {
  if (configs === undefined) return undefined;
  return configs.map((config) => ({
    label: config.label,
    triggerType: config.triggerType,
    triggerNumber: config.triggerNumber,
    triggerId: config.triggerId,
    properties: config.properties,
    description: config.description,
  }));
};

const toAttrs = (
  version: integrations.GoogleCloudIntegrationsV1alphaIntegrationVersion,
  project: string,
  region: string,
) => {
  const name = version.name ?? "";
  const parsed = parseOwnership(version.description);
  return {
    name,
    versionId: lastSegment(name),
    integrationId: integrationIdOf(name),
    integration: integrationOf(name),
    location: locationOf(name, region),
    product: productOf(name),
    project,
    description: parsed.text,
    userLabel: version.userLabel,
    triggerConfigs: triggersOf(version.triggerConfigs),
    status: version.status,
    state: version.state,
    snapshotNumber: version.snapshotNumber,
    createTime: version.createTime,
    updateTime: version.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations
        .getProjectsLocationsProductsIntegrationsVersions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  integrations.listProjectsLocationsProductsIntegrationsVersions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.integrationVersions ?? []),
      ),
      Stream.filter((version) => hasOwnershipMarker(version.description)),
      Stream.map((version) => toAttrs(version, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  integrations.listProjectsLocationsProductsIntegrationsVersions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.integrationVersions ?? []),
      ),
      Stream.filterEffect((version) => ownedByAlchemy(id, version.description)),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

const deleteIntegration = (name: string) =>
  name.length === 0
    ? Effect.void
    : integrations.deleteProjectsLocationsIntegrations({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("BadRequest", () => Effect.void),
        Effect.catchTag("Conflict", () => Effect.void),
      );

export const ProductsIntegrationsVersionProvider = () =>
  Provider.succeed(ProductsIntegrationsVersion, {
    stables: [
      "name",
      "versionId",
      "integrationId",
      "integration",
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
      const previousIntegration = olds?.integrationId ?? output?.integrationId;
      if (
        previousIntegration !== undefined &&
        news.integrationId !== undefined &&
        news.integrationId !== previousIntegration
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.versionId ?? output?.versionId;
      if (
        previousId !== undefined &&
        news.versionId !== undefined &&
        news.versionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const integrationId = yield* toResourceId(
        id,
        olds?.integrationId,
        output?.integrationId,
      );
      const versionId = olds?.versionId ?? output?.versionId ?? "";
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const product = normalizeProduct(olds?.product ?? output?.product);
      const name =
        output?.name ??
        (versionId.length > 0
          ? resourceName(
              env.project,
              location,
              product,
              integrationId,
              versionId,
            )
          : "");
      let existing = yield* getByName(name);
      if (existing === undefined) {
        existing = yield* findOwned(
          `${productParent(env.project, location, product)}/integrations/${integrationId}`,
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
          `${productParent(env.project, env.region, DEFAULT_PRODUCT)}/integrations/-`,
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
      const integrationId = yield* toResourceId(
        id,
        news.integrationId,
        output?.integrationId,
      );
      const parent = `${productParent(env.project, location, product)}/integrations/${integrationId}`;
      const versionId = news.versionId ?? output?.versionId ?? "";
      const name =
        output?.name ??
        (versionId.length > 0
          ? resourceName(
              env.project,
              location,
              product,
              integrationId,
              versionId,
            )
          : parent);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const triggerConfigs = news.triggerConfigs;
      const newIntegration = news.newIntegration !== false;

      let current = yield* getByName(output?.name ?? (versionId ? name : ""));
      if (current === undefined) {
        current = yield* findOwned(parent, id);
      }

      if (current === undefined) {
        const tryCreate = (createNew: boolean) =>
          integrations.createProjectsLocationsProductsIntegrationsVersions({
            parent,
            newIntegration: createNew,
            body: {
              description,
              userLabel: news.userLabel,
              triggerConfigs,
            },
          });
        const created = yield* tryCreate(newIntegration).pipe(
          Effect.catchTag(["Conflict", "BadRequest"], () =>
            tryCreate(false).pipe(
              Effect.catchTag(["Conflict", "BadRequest"], () =>
                findOwned(parent, id),
              ),
            ),
          ),
        );
        current = created ?? (yield* findOwned(parent, id));
      }

      if (current === undefined) {
        return yield* new ProductsIntegrationsVersionNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const descriptionChanged = (current.description ?? "") !== description;
      const labelChanged = !sameText(current.userLabel, news.userLabel);
      const triggersChanged =
        JSON.stringify(triggersOf(current.triggerConfigs) ?? null) !==
        JSON.stringify(triggerConfigs ?? null);

      if (descriptionChanged || labelChanged || triggersChanged) {
        current =
          yield* integrations.patchProjectsLocationsProductsIntegrationsVersions(
            {
              name: currentName,
              updateMask: updateMaskOf(
                descriptionChanged ? "description" : undefined,
                labelChanged ? "user_label" : undefined,
                triggersChanged ? "trigger_configs" : undefined,
              ),
              body: {
                name: currentName,
                description,
                userLabel: news.userLabel,
                triggerConfigs,
              },
            },
          );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsProductsIntegrationsVersions({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.catchTag("BadRequest", () => Effect.void),
          Effect.catchTag("Conflict", () => Effect.void),
        );
      const stripped = `${locationParent(output.project, output.location)}/integrations/${output.integrationId}`;
      yield* deleteIntegration(output.integration);
      if (stripped !== output.integration) {
        yield* deleteIntegration(stripped);
      }
    }),
  });
