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
import type { ClientCertificate } from "./shared.ts";

export type ProductsCertificateProps = {
  /**
   * Certificate id (the `{certificate}` segment). Server-assigned on
   * create. Immutable — changing it replaces the certificate.
   */
  certificateId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * certificate. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Product id (`IP` for Application Integration, `APIGEE` for Apigee
   * Integration). Immutable — changing it replaces the certificate.
   * @default "IP"
   */
  product?: string;
  /**
   * Display name.
   */
  displayName?: string;
  /**
   * Human-readable description. Certificates have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Requestor id registered with trawler. Immutable.
   */
  requestorId?: string;
  /**
   * Raw client certificate (PEM). Write-only — never returned on
   * attributes. Changing it replaces the certificate.
   */
  rawCertificate?: ClientCertificate;
};

export type ProductsCertificate = Resource<
  "GCP.Integrations.ProductsCertificate",
  ProductsCertificateProps,
  {
    /** Full resource name. */
    name: string;
    /** Certificate id (last path segment). */
    certificateId: string;
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
    /** Requestor id. */
    requestorId: string | undefined;
    /** Certificate status (`ACTIVE`, `EXPIRED`, …). */
    certificateStatus: string | undefined;
    /** RFC3339 start of validity. */
    validStartTime: string | undefined;
    /** RFC3339 end of validity. */
    validEndTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A product-scoped Application Integration client certificate
 * (`projects/.../products/{product}/certificates/{certificate}`).
 *
 * Certificates have no labels field — Alchemy stamps ownership into the
 * description. Location, product, and id are immutable. Display name
 * and description update in place. The PEM payload is write-only.
 *
 * ### Creating a Certificate
 * **Example:** Register a PEM client cert
 * ```typescript
 * const cert = yield* GCP.Integrations.ProductsCertificate("ClientTls", {
 *   product: "IP",
 *   displayName: "client-tls",
 *   rawCertificate: {
 *     sslCertificate: pem,
 *     encryptedPrivateKey: keyPem,
 *   },
 * });
 * ```
 *
 * @resource
 * @category Integrations
 */
export const ProductsCertificate = Resource<ProductsCertificate>(
  "GCP.Integrations.ProductsCertificate",
);

export class ProductsCertificateNotResolved extends Data.TaggedError(
  "GCP.Integrations.ProductsCertificateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  product: string,
  certificateId: string,
) =>
  `${productParent(project, location, product)}/certificates/${certificateId}`;

const toAttrs = (
  certificate: integrations.GoogleCloudIntegrationsV1alphaCertificate,
  project: string,
  region: string,
) => {
  const name = certificate.name ?? "";
  const parsed = parseOwnership(certificate.description);
  return {
    name,
    certificateId: lastSegment(name),
    location: locationOf(name, region),
    product: productOf(name),
    project,
    displayName: certificate.displayName,
    description: parsed.text,
    requestorId: certificate.requestorId,
    certificateStatus: certificate.certificateStatus,
    validStartTime: certificate.validStartTime,
    validEndTime: certificate.validEndTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : integrations
        .getProjectsLocationsProductsCertificates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  integrations.listProjectsLocationsProductsCertificates
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.certificates ?? [])),
      Stream.filter((certificate) =>
        hasOwnershipMarker(certificate.description),
      ),
      Stream.map((certificate) => toAttrs(certificate, project, region)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findOwned = (parent: string, id: string) =>
  integrations.listProjectsLocationsProductsCertificates
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.certificates ?? [])),
      Stream.filterEffect((certificate) =>
        ownedByAlchemy(id, certificate.description),
      ),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const ProductsCertificateProvider = () =>
  Provider.succeed(ProductsCertificate, {
    stables: [
      "name",
      "certificateId",
      "location",
      "product",
      "project",
      "requestorId",
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
      const previousId = olds?.certificateId ?? output?.certificateId;
      if (
        previousId !== undefined &&
        news.certificateId !== undefined &&
        news.certificateId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      // The patch API only accepts certificate_name, description, and
      // certificate_status, so a new raw certificate needs a new resource.
      if (
        olds !== undefined &&
        JSON.stringify(olds.rawCertificate ?? null) !==
          JSON.stringify(news.rawCertificate ?? null)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const certificateId = yield* toResourceId(
        id,
        olds?.certificateId,
        output?.certificateId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const product = normalizeProduct(olds?.product ?? output?.product);
      const name =
        output?.name ??
        resourceName(env.project, location, product, certificateId);
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
      const certificateId = yield* toResourceId(
        id,
        news.certificateId,
        output?.certificateId,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, product, certificateId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? certificateId;

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findOwned(parent, id);
      }

      if (current === undefined) {
        const created = yield* integrations
          .createProjectsLocationsProductsCertificates({
            parent,
            body: {
              displayName,
              description,
              requestorId: news.requestorId,
              rawCertificate: news.rawCertificate,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(parent, id)));
        current = created ?? (yield* findOwned(parent, id));
      }

      if (current === undefined) {
        return yield* new ProductsCertificateNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;

      if (displayChanged || descriptionChanged) {
        current =
          yield* integrations.patchProjectsLocationsProductsCertificates({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "certificate_name" : undefined,
              descriptionChanged ? "description" : undefined,
            ),
            body: {
              name: currentName,
              displayName,
              description,
            },
          });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* integrations
        .deleteProjectsLocationsProductsCertificates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
