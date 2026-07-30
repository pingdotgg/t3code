import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { listAllZones } from "../Zone/lookup.ts";

const TypeId = "Cloudflare.ApiShield.UserSchema" as const;
type TypeId = typeof TypeId;

export interface UserSchemaProps {
  /**
   * Zone the schema is uploaded to.
   *
   * Immutable — moving a schema between zones triggers a replacement.
   */
  zoneId: string;
  /**
   * Name of the schema. If omitted, a unique name is generated from the
   * app, stage, and logical ID.
   *
   * Immutable — there is no rename API, so changing the name triggers a
   * replacement.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * The OpenAPI v3 schema source (JSON or YAML) to upload.
   *
   * Immutable — Cloudflare offers no API to update an uploaded schema's
   * contents, so changing the source triggers a replacement.
   */
  schema: string;
  /**
   * Whether the schema is enabled for (legacy "classic") schema
   * validation. Enabling is an in-place update; Cloudflare forbids
   * disabling an enabled schema (error 20400), so turning this back off
   * triggers a replacement.
   * @default false
   */
  validationEnabled?: boolean;
}

export interface UserSchemaAttributes {
  /** Cloudflare-assigned UUID of the schema. */
  schemaId: string;
  /** Zone the schema is uploaded to. */
  zoneId: string;
  /** Name of the schema. */
  name: string;
  /** Kind of schema. Always `openapi_v3`. */
  kind: "openapi_v3";
  /** The schema source as stored by Cloudflare. */
  source: string;
  /** Whether the schema is enabled for validation. */
  validationEnabled: boolean;
  /** ISO8601 creation timestamp. */
  createdAt: string;
}

export type UserSchema = Resource<
  TypeId,
  UserSchemaProps,
  UserSchemaAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare API Shield user schema — an OpenAPI v3 document uploaded to
 * a zone for (legacy "classic") schema validation of API traffic.
 *
 * An uploaded schema's contents cannot be modified, so changing the
 * `schema` source (or the `name`) triggers a replacement. The only in-place
 * update is enabling validation; Cloudflare forbids disabling an enabled
 * schema, so turning validation back off also triggers a replacement.
 *
 * For current zone-level schema validation (v2), prefer the
 * `Cloudflare.SchemaValidation` resources.
 * @resource
 * @product API Shield
 * @category Application Security
 * @section Uploading a Schema
 * @example Upload an OpenAPI v3 schema
 * ```typescript
 * const fs = yield* FileSystem.FileSystem;
 * const source = yield* fs.readFileString("./openapi.json");
 *
 * const schema = yield* Cloudflare.ApiShield.UserSchema("PetstoreSchema", {
 *   zoneId: zone.zoneId,
 *   name: "petstore",
 *   schema: source,
 * });
 * // schema.schemaId is the Cloudflare-assigned UUID
 * ```
 *
 * @example Upload and enable validation
 * ```typescript
 * yield* Cloudflare.ApiShield.UserSchema("PetstoreSchema", {
 *   zoneId: zone.zoneId,
 *   schema: source,
 *   validationEnabled: true,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/api-shield/security/schema-validation/
 */
export const UserSchema = Resource<UserSchema>(TypeId);

/**
 * Returns true if the given value is an UserSchema resource.
 */
export const isUserSchema = (value: unknown): value is UserSchema =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const UserSchemaProvider = () =>
  Provider.succeed(UserSchema, {
    stables: ["zoneId", "name", "kind"],

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const o = olds as UserSchemaProps | undefined;
      const n = news as UserSchemaProps;
      if (o === undefined) return undefined;
      // The name is part of the schema's identity — compare the resolved
      // physical names (an omitted name resolves deterministically).
      const oldName = output?.name ?? (yield* createSchemaName(id, o.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const newName = n.name ?? oldName;
      if (oldName !== newName) {
        return { action: "replace" } as const;
      }
      // The uploaded source cannot be modified in place.
      if (o.schema !== n.schema) {
        return { action: "replace" } as const;
      }
      // Cloudflare forbids disabling validation on an enabled schema.
      if ((o.validationEnabled ?? false) && !(n.validationEnabled ?? false)) {
        return { action: "replace" } as const;
      }
      // zoneId is Input<string>; compare only once both are concrete.
      if (
        typeof o.zoneId === "string" &&
        typeof n.zoneId === "string" &&
        o.zoneId !== n.zoneId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const zoneId = output?.zoneId ?? (olds?.zoneId as string | undefined);
      if (zoneId === undefined) return undefined;

      // Owned path: refresh by the persisted schema id.
      if (output?.schemaId) {
        const observed = yield* getSchema(zoneId, output.schemaId);
        return observed ? toAttributes(observed, zoneId) : undefined;
      }

      // Cold path: recover from lost state via the deterministic name.
      // Schemas carry no ownership markers, so an existing schema is
      // reported as `Unowned` and adoption is gated by the adopt policy.
      const name = yield* createSchemaName(id, olds?.name);
      const observed = yield* findByName(zoneId, name);
      return observed ? Unowned(toAttributes(observed, zoneId)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      // Inputs have been resolved to concrete strings by Plan.
      const zoneId = news.zoneId as string;
      const name = output?.name ?? (yield* createSchemaName(id, news.name));
      const desiredEnabled = news.validationEnabled ?? false;

      // 1. Observe — the schema id cached on `output` is a hint, not a
      //    guarantee: a missing schema falls through to ensure.
      let observed = output?.schemaId
        ? yield* getSchema(zoneId, output.schemaId)
        : undefined;

      // An adopted (or drifted) schema whose stored source no longer
      // matches the desired one cannot be updated in place — converge by
      // recreating it.
      if (observed && (observed.source ?? "") !== news.schema) {
        yield* apiGateway
          .deleteUserSchema({ zoneId, schemaId: observed.schemaId })
          .pipe(Effect.catchTag("SchemaNotFound", () => Effect.void));
        observed = undefined;
      }

      // 2. Ensure — upload when missing. Names are not unique, so there is
      //    no AlreadyExists race to tolerate.
      if (!observed) {
        const file = yield* Effect.sync(
          () => new File([news.schema], `${name}.json`),
        );
        const created = yield* apiGateway.createUserSchema({
          zoneId,
          file,
          kind: "openapi_v3",
          name,
          validationEnabled: desiredEnabled,
        });
        observed = created.schema;
      }

      // 3. Sync — enabling validation is the only in-place update (the
      //    disable direction is a replacement, handled by diff). Skip the
      //    patch entirely on a no-op.
      if (desiredEnabled && !(observed.validationEnabled ?? false)) {
        const patched = yield* apiGateway.patchUserSchema({
          zoneId,
          schemaId: observed.schemaId,
          validationEnabled: true,
        });
        // The patch response omits the source — keep the observed one.
        observed = { ...patched, source: observed.source };
      }

      return toAttributes(observed, zoneId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apiGateway
        .deleteUserSchema({
          zoneId: output.zoneId,
          schemaId: output.schemaId,
        })
        .pipe(Effect.catchTag("SchemaNotFound", () => Effect.void));
    }),

    // Schemas live inside a zone; there is no account-wide list. Fan out
    // over every zone in the account and exhaustively paginate each zone's
    // schemas, hydrating into the same `Attributes` shape `read` produces.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const zones = yield* listAllZones(accountId);
      const rows = yield* Effect.forEach(
        zones,
        (zone) =>
          apiGateway.listUserSchemas.pages({ zoneId: zone.id }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((schema) =>
                  toAttributes(schema, zone.id),
                ),
              ),
            ),
            // Zones without the API Shield entitlement reject the listing
            // route; skip them rather than failing the whole enumeration.
            Effect.catchTag("Forbidden", () =>
              Effect.succeed([] as UserSchemaAttributes[]),
            ),
            // A zone purged (deleted) out-of-band mid-enumeration — it was in
            // the zone list but no longer exists; drop it.
            Effect.catchTag("ZonePurged", () =>
              Effect.succeed([] as UserSchemaAttributes[]),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

type ObservedSchema = Pick<
  apiGateway.GetUserSchemaResponse,
  "schemaId" | "name" | "kind" | "source" | "validationEnabled" | "createdAt"
>;

/**
 * Read a schema by id, mapping "gone" (`SchemaNotFound`, Cloudflare error
 * code 19400) to `undefined`.
 */
const getSchema = (zoneId: string, schemaId: string) =>
  apiGateway.getUserSchema({ zoneId, schemaId }).pipe(
    Effect.map((schema): ObservedSchema | undefined => schema),
    Effect.catchTag("SchemaNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a schema by name. Cloudflare does not enforce name uniqueness, so
 * the first match wins — cold recovery only ever races with itself here
 * because generated names are deterministic per logical ID.
 */
const findByName = (zoneId: string, name: string) =>
  apiGateway.listUserSchemas.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (schema): schema is ObservedSchema & typeof schema =>
          schema.name === name,
      ),
    ),
  );

/**
 * Resolve the schema's physical name: the explicit prop wins; otherwise a
 * deterministic name is generated from the app, stage, and logical ID.
 */
const createSchemaName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  schema: ObservedSchema,
  zoneId: string,
): UserSchemaAttributes => ({
  schemaId: schema.schemaId,
  zoneId,
  name: schema.name,
  kind: schema.kind,
  source: schema.source ?? "",
  validationEnabled: schema.validationEnabled ?? false,
  createdAt: schema.createdAt,
});
