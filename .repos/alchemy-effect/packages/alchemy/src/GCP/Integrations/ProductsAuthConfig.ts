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
import type {
  AuthConfigVisibility,
  CredentialType,
  DecryptedCredential,
} from "./shared.ts";
import { credentialBody } from "./shared.ts";

export type ProductsAuthConfigProps = {
  /**
   * Auth config id (the `{authConfig}` segment). Server-assigned on
   * create. Immutable — changing it replaces the config.
   */
  authConfigId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * config. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Product id (`IP` for Application Integration, `APIGEE` for Apigee
   * Integration). Immutable — changing it replaces the config.
   * @default "IP"
   */
  product?: string;
  /**
   * Unique display name within the client.
   */
  displayName?: string;
  /**
   * Human-readable description. Auth configs have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Credential type applied to `decryptedCredential` when it omits one.
   * @default "USERNAME_AND_PASSWORD"
   */
  credentialType?: CredentialType;
  /**
   * Decrypted credential payload. Write-only — never returned on
   * attributes.
   */
  decryptedCredential?: DecryptedCredential;
  /**
   * Certificate id used for client-certificate auth.
   */
  certificateId?: string;
  /**
   * Visibility of the auth config.
   * @default "PRIVATE"
   */
  visibility?: AuthConfigVisibility;
};

export type ProductsAuthConfig = Resource<
  "GCP.Integrations.ProductsAuthConfig",
  ProductsAuthConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Auth config id (last path segment). */
    authConfigId: string;
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
    /** Credential type. */
    credentialType: string | undefined;
    /** Certificate id, if any. */
    certificateId: string | undefined;
    /** Visibility. */
    visibility: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A product-scoped Application Integration auth config
 * (`projects/.../products/{product}/authConfigs/{authConfig}`).
 *
 * Auth configs have no labels field — Alchemy stamps ownership into the
 * description. Location, product, and id are immutable. Display name,
 * description, visibility, and credentials update in place.
 *
 * ### Creating a Product Auth Config
 * **Example:** Username and password under `IP`
 * ```typescript
 * const auth = yield* GCP.Integrations.ProductsAuthConfig("Salesforce", {
 *   product: "IP",
 *   displayName: "salesforce-basic",
 *   credentialType: "USERNAME_AND_PASSWORD",
 *   decryptedCredential: {
 *     credentialType: "USERNAME_AND_PASSWORD",
 *     usernameAndPassword: { username: "user", password: "secret" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const ProductsAuthConfig = Resource<ProductsAuthConfig>(
  "GCP.Integrations.ProductsAuthConfig",
);

export class ProductsAuthConfigNotResolved extends Data.TaggedError(
  "GCP.Integrations.ProductsAuthConfigNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_CREDENTIAL_TYPE: CredentialType = "USERNAME_AND_PASSWORD";
const DEFAULT_VISIBILITY: AuthConfigVisibility = "PRIVATE";

const resourceName = (
  project: string,
  location: string,
  product: string,
  authConfigId: string,
) => `${productParent(project, location, product)}/authConfigs/${authConfigId}`;

const toAttrs = (
  config: integrations.GoogleCloudIntegrationsV1alphaAuthConfig,
  project: string,
  region: string,
) => {
  const name = config.name ?? "";
  const parsed = parseOwnership(config.description);
  return {
    name,
    authConfigId: lastSegment(name),
    location: locationOf(name, region),
    product: productOf(name),
    project,
    displayName: config.displayName,
    description: parsed.text,
    credentialType:
      config.credentialType ?? config.decryptedCredential?.credentialType,
    certificateId: config.certificateId,
    visibility: config.visibility,
    state: config.state,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations
        .getProjectsLocationsProductsAuthConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  integrations.listProjectsLocationsProductsAuthConfigs
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.authConfigs ?? [])),
      Stream.filter((config) => hasOwnershipMarker(config.description)),
      Stream.map((config) => toAttrs(config, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  integrations.listProjectsLocationsProductsAuthConfigs
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.authConfigs ?? [])),
      Stream.filterEffect((config) => ownedByAlchemy(id, config.description)),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const ProductsAuthConfigProvider = () =>
  Provider.succeed(ProductsAuthConfig, {
    stables: [
      "name",
      "authConfigId",
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
      const previousId = olds?.authConfigId ?? output?.authConfigId;
      if (
        previousId !== undefined &&
        news.authConfigId !== undefined &&
        news.authConfigId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const authConfigId = yield* toResourceId(
        id,
        olds?.authConfigId,
        output?.authConfigId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const product = normalizeProduct(olds?.product ?? output?.product);
      const name =
        output?.name ??
        resourceName(env.project, location, product, authConfigId);
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
      const authConfigId = yield* toResourceId(
        id,
        news.authConfigId,
        output?.authConfigId,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, product, authConfigId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? authConfigId;
      const credentialType = news.credentialType ?? DEFAULT_CREDENTIAL_TYPE;
      const visibility = news.visibility ?? DEFAULT_VISIBILITY;
      const decryptedCredential = credentialBody(
        news.decryptedCredential,
        credentialType,
      );

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findOwned(parent, id);
      }

      if (current === undefined) {
        const created = yield* integrations
          .createProjectsLocationsProductsAuthConfigs({
            parent,
            body: {
              displayName,
              description,
              decryptedCredential,
              certificateId: news.certificateId,
              visibility,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(parent, id)));
        current = created ?? (yield* findOwned(parent, id));
      }

      if (current === undefined) {
        return yield* new ProductsAuthConfigNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const visibilityChanged = !sameText(current.visibility, visibility);
      const certificateChanged = !sameText(
        current.certificateId,
        news.certificateId,
      );
      const credentialChanged = news.decryptedCredential !== undefined;

      if (
        displayChanged ||
        descriptionChanged ||
        visibilityChanged ||
        certificateChanged ||
        credentialChanged
      ) {
        current = yield* integrations.patchProjectsLocationsProductsAuthConfigs(
          {
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              visibilityChanged ? "visibility" : undefined,
              certificateChanged ? "certificate_id" : undefined,
              credentialChanged ? "decrypted_credential" : undefined,
            ),
            body: {
              name: currentName,
              displayName,
              description,
              decryptedCredential,
              certificateId: news.certificateId,
              visibility,
            },
          },
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsProductsAuthConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
