import * as schemaValidation from "@distilled.cloud/cloudflare/schema-validation";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.SchemaValidation.Schema" as const;
type TypeId = typeof TypeId;

export interface SchemaProps {
  /**
   * Zone the schema is uploaded to.
   *
   * Immutable — moving a schema between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * Human-readable name for the schema. Cloudflare does not enforce
   * uniqueness, but Alchemy uses the name as the cold-read identity, so it
   * should be unique within the zone. If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   *
   * Immutable — there is no rename API, so changing the name triggers a
   * replacement.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The kind of the schema. Only OpenAPI v3 is supported.
   *
   * Immutable — changing the kind triggers a replacement.
   * @default "openapi_v3"
   */
  kind?: "openapi_v3";
  /**
   * The raw OpenAPI v3 schema, as a JSON or YAML string. Cloudflare
   * validates the document on upload and rejects invalid specs.
   *
   * Immutable — the uploaded source cannot be modified, so changing it
   * triggers a replacement (a new schema is uploaded, then the old one is
   * deleted).
   */
  source: string;
  /**
   * Whether the schema is enabled for validation.
   *
   * Enabling a disabled schema is an in-place update, but Cloudflare does
   * not allow disabling an enabled schema ("delete schema instead"), so
   * changing `true` → `false` triggers a replacement.
   * @default true
   */
  validationEnabled?: boolean;
}

export interface SchemaAttributes {
  /** Cloudflare-assigned UUID of the schema. */
  schemaId: string;
  /** Zone the schema is uploaded to. */
  zoneId: string;
  /** Human-readable name of the schema. */
  name: string;
  /** The kind of the schema. */
  kind: "openapi_v3";
  /** The raw schema source as stored by Cloudflare. */
  source: string;
  /** Whether the schema is enabled for validation. */
  validationEnabled: boolean;
  /** When the schema was uploaded. */
  createdAt: string;
}

export type SchemaValidationSchema = Resource<
  TypeId,
  SchemaProps,
  SchemaAttributes,
  never,
  Providers
>;

/**
 * An OpenAPI v3 schema uploaded to a zone for API Shield schema validation
 * (`/zones/{zone_id}/schema_validation/schemas`).
 *
 * Uploading a schema registers the endpoints it describes as API Shield
 * operations (a server-side side effect — deleting the schema does not
 * delete those operations). The schema body is immutable: changing `source`
 * uploads a new schema and deletes the old one (replacement). Only the
 * `validationEnabled` flag is mutable in place.
 * @resource
 * @product Schema Validation
 * @category Application Security
 * @section Uploading a Schema
 * @example Upload an OpenAPI v3 schema
 * ```typescript
 * const schema = yield* Cloudflare.SchemaValidation.SchemaValidationSchema("ApiSchema", {
 *   zoneId: zone.zoneId,
 *   source: JSON.stringify({
 *     openapi: "3.0.0",
 *     info: { title: "my-api", version: "1.0.0" },
 *     servers: [{ url: "https://api.example.com" }],
 *     paths: {
 *       "/users": {
 *         get: {
 *           operationId: "listUsers",
 *           responses: { "200": { description: "ok" } },
 *         },
 *       },
 *     },
 *   }),
 * });
 * ```
 *
 * @example Upload a schema without enabling validation
 * ```typescript
 * const schema = yield* Cloudflare.SchemaValidation.SchemaValidationSchema("DraftSchema", {
 *   zoneId: zone.zoneId,
 *   source: openApiDocument,
 *   validationEnabled: false,
 * });
 * ```
 *
 * @section Toggling validation
 * @example Enable a previously-disabled schema in place
 * ```typescript
 * // Enabling (false → true) patches the schema in place. Disabling an
 * // enabled schema is rejected by Cloudflare, so `true` → `false` (like a
 * // `source` change) replaces the schema instead.
 * yield* Cloudflare.SchemaValidation.SchemaValidationSchema("DraftSchema", {
 *   zoneId: zone.zoneId,
 *   source: openApiDocument,
 *   validationEnabled: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api-shield/security/schema-validation/
 */
export const SchemaValidationSchema = Resource<SchemaValidationSchema>(TypeId);

/**
 * Returns true if the given value is a SchemaValidationSchema resource.
 */
export const isSchema = (value: unknown): value is SchemaValidationSchema =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SchemaProvider = () =>
  Provider.succeed(SchemaValidationSchema, {
    stables: ["schemaId", "zoneId", "name", "kind", "source", "createdAt"],

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      // zoneId is a path param — moving zones is a replacement.
      if (
        output?.zoneId !== undefined &&
        typeof news.zoneId === "string" &&
        news.zoneId !== output.zoneId
      ) {
        return { action: "replace" } as const;
      }
      // kind is immutable.
      const oldKind = output?.kind ?? olds?.kind ?? "openapi_v3";
      if ((news.kind ?? "openapi_v3") !== oldKind) {
        return { action: "replace" } as const;
      }
      // There is no rename API. A generated name (news.name undefined) is
      // deterministic and therefore never drifts.
      const oldName = output?.name ?? olds?.name;
      if (
        news.name !== undefined &&
        oldName !== undefined &&
        news.name !== oldName
      ) {
        return { action: "replace" } as const;
      }
      // The uploaded source is immutable. Prefer the previously-passed
      // props as the baseline (what the user last declared) over the
      // stored copy, in case Cloudflare ever normalizes the document.
      const oldSource = olds?.source ?? output?.source;
      if (oldSource !== undefined && news.source !== oldSource) {
        return { action: "replace" } as const;
      }
      // Cloudflare rejects disabling an enabled schema in place
      // ("Disabling a schema is not allowed, delete schema instead.") —
      // converge by replacing: upload a new, disabled copy and delete the
      // old one. Enabling (false → true) is a plain in-place update.
      const oldEnabled =
        output?.validationEnabled ?? olds?.validationEnabled ?? true;
      if (oldEnabled && news.validationEnabled === false) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const zoneId =
        output?.zoneId ??
        (typeof olds?.zoneId === "string" ? olds.zoneId : undefined);
      if (zoneId === undefined) return undefined;

      if (output?.schemaId) {
        const observed = yield* getSchema(zoneId, output.schemaId);
        return observed ? toAttributes(zoneId, observed) : undefined;
      }

      // Cold read — recover from lost state by matching the deterministic
      // name. Names are not unique server-side and carry no ownership
      // marker, so brand the match `Unowned` and let the engine gate
      // takeover behind adoption.
      const name = yield* createSchemaName(id, olds?.name);
      const match = yield* findByName(zoneId, name);
      if (match === undefined) return undefined;
      const observed = yield* getSchema(zoneId, match.schemaId);
      return observed ? Unowned(toAttributes(zoneId, observed)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const name = yield* createSchemaName(id, news.name);
      const desiredEnabled = news.validationEnabled ?? true;

      // 1. Observe — the cached schemaId is a hint, not a guarantee: a
      //    SchemaNotFound falls through to "missing" and we re-upload.
      const observed = output?.schemaId
        ? yield* getSchema(zoneId, output.schemaId)
        : undefined;

      // 2. Ensure — upload when missing. Names are not unique server-side,
      //    so there is no AlreadyExists race to tolerate.
      if (observed === undefined) {
        const created = yield* schemaValidation.createSchema({
          zoneId,
          kind: news.kind ?? "openapi_v3",
          name,
          source: news.source,
          validationEnabled: desiredEnabled,
        });
        return toAttributes(zoneId, created);
      }

      // 3. Sync — `validationEnabled` is the only mutable aspect; the
      //    source/name/kind are immutable and disabling is rejected by the
      //    API, so diff replaces on those changes. Skip the API call
      //    entirely on a no-op.
      if ((observed.validationEnabled ?? false) === desiredEnabled) {
        return toAttributes(zoneId, observed);
      }
      const patched = yield* schemaValidation.patchSchema({
        zoneId,
        schemaId: observed.schemaId,
        validationEnabled: desiredEnabled,
      });
      // The PATCH response omits the stored source (returns "") — keep the
      // observed copy so the attributes stay faithful.
      return toAttributes(zoneId, { ...patched, source: observed.source });
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent — a schema already deleted out-of-band is success.
      yield* schemaValidation
        .deleteSchema({ zoneId: output.zoneId, schemaId: output.schemaId })
        .pipe(Effect.catchTag("SchemaNotFound", () => Effect.void));
    }),

    // Zone-scoped collection: schemas live under `/zones/{zone_id}/...`, so
    // enumerate every zone in the account and list its schemas, paginating
    // each exhaustively. `omitSource: false` hydrates the full `read`
    // Attributes shape. Zones whose route is invalid (deleted/partial) reject
    // with the typed `InvalidRoute` — skip them rather than failing the whole
    // enumeration.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          schemaValidation.listSchemas
            .pages({ zoneId: zone.id, omitSource: false })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.result ?? []).map((schema) =>
                    toAttributes(zone.id, schema),
                  ),
                ),
              ),
              // Skip zones schema-validation can't enumerate: `InvalidRoute`
              // (feature not available on the zone), `ZonePurged` (the
              // account-wide zone listing can momentarily include a zone that
              // has since been purged), and `Forbidden` (the scoped token /
              // zone plan doesn't grant schema-validation access).
              Effect.catchTag(["InvalidRoute", "ZonePurged", "Forbidden"], () =>
                Effect.succeed<SchemaAttributes[]>([]),
              ),
            ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

/**
 * Read a schema by id, mapping "gone" (`SchemaNotFound`, Cloudflare error
 * code 19400) to `undefined`.
 */
const getSchema = (zoneId: string, schemaId: string) =>
  schemaValidation
    .getSchema({ zoneId, schemaId, omitSource: false })
    .pipe(Effect.catchTag("SchemaNotFound", () => Effect.succeed(undefined)));

/**
 * Find a schema by exact name (meta-data only — sources omitted). If several
 * schemas carry the same name, pick the oldest for determinism.
 */
const findByName = (zoneId: string, name: string) =>
  schemaValidation.listSchemas.items({ zoneId, omitSource: true }).pipe(
    Stream.filter((s) => s.name === name),
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(0),
    ),
  );

const createSchemaName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  zoneId: string,
  schema:
    | schemaValidation.GetSchemaResponse
    | schemaValidation.CreateSchemaResponse
    | schemaValidation.PatchSchemaResponse
    | schemaValidation.ListSchemasResponse["result"][number],
): SchemaAttributes => ({
  schemaId: schema.schemaId,
  zoneId,
  name: schema.name,
  kind: schema.kind,
  source: schema.source,
  validationEnabled: schema.validationEnabled ?? false,
  createdAt: schema.createdAt,
});
