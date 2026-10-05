import * as apihub from "@distilled.cloud/gcp/apihub_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ApihubNotResolved,
  createOwnership,
  encodeOwnership,
  hasOwnershipMarker,
  listAttributes,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

export type AllowedValue = {
  /** Allowed value id. Generated from the display name when omitted. */
  id?: string;
  /** Display name. Required. */
  displayName: string;
  /** Description of the allowed value. */
  description?: string;
  /** When true, the value cannot be updated or deleted. */
  immutable?: boolean;
};

export type AttributeProps = {
  /**
   * Attribute id (the `{attribute}` segment of
   * `projects/{project}/locations/{location}/attributes/{attribute}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces
   * the attribute.
   */
  attributeId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * attribute.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name. Required.
   */
  displayName: string;
  /**
   * Human-readable description. Attributes have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  description?: string;
  /**
   * Data type. Immutable — changing it replaces the attribute.
   */
  dataType:
    | "DATA_TYPE_UNSPECIFIED"
    | "ENUM"
    | "JSON"
    | "STRING"
    | "URI"
    | (string & {});
  /**
   * Resource this attribute can attach to. Immutable — changing it
   * replaces the attribute.
   */
  scope:
    | "SCOPE_UNSPECIFIED"
    | "API"
    | "VERSION"
    | "SPEC"
    | "API_OPERATION"
    | "DEPLOYMENT"
    | "DEPENDENCY"
    | "DEFINITION"
    | "EXTERNAL_API"
    | "PLUGIN"
    | (string & {});
  /**
   * Maximum number of values when associated with a resource (1-20).
   * Cardinality can only be increased.
   * @default 1
   */
  cardinality?: number;
  /**
   * Allowed values when `dataType` is `ENUM`.
   */
  allowedValues?: AllowedValue[];
};

export type Attribute = Resource<
  "GCP.ApiHub.Attribute",
  AttributeProps,
  {
    /** Full resource name. */
    name: string;
    /** Attribute id (last path segment). */
    attributeId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Data type. */
    dataType: string | undefined;
    /** Scope. */
    scope: string | undefined;
    /** Cardinality. */
    cardinality: number | undefined;
    /** Allowed enum values. */
    allowedValues: AllowedValue[];
    /** Whether the attribute is mandatory. */
    mandatory: boolean;
    /** Definition type (`SYSTEM_DEFINED` or `USER_DEFINED`). */
    definitionType: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A user-defined attribute in API Hub. System-defined attributes cannot
 * be created or deleted through this resource.
 *
 * Location, id, data type, and scope are immutable. Display name,
 * description, allowed values, and cardinality (increase only) update in
 * place. Attributes have no labels field — Alchemy stamps ownership into
 * the description.
 *
 * ### Creating an Attribute
 * **Example:** String attribute on APIs
 * ```typescript
 * const attribute = yield* GCP.ApiHub.Attribute("OwnerTeam", {
 *   displayName: "owner-team",
 *   dataType: "STRING",
 *   scope: "API",
 * });
 * ```
 *
 * **Example:** Enum attribute
 * ```typescript
 * const attribute = yield* GCP.ApiHub.Attribute("Tier", {
 *   displayName: "tier",
 *   dataType: "ENUM",
 *   scope: "API",
 *   allowedValues: [
 *     { id: "gold", displayName: "gold" },
 *     { id: "silver", displayName: "silver" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const Attribute = Resource<Attribute>("GCP.ApiHub.Attribute");

const resourceName = (project: string, location: string, attributeId: string) =>
  `${locationParent(project, location)}/attributes/${attributeId}`;

const toAllowed = (
  values: apihub.GoogleCloudApihubV1AllowedValueList | undefined,
): AllowedValue[] =>
  (values ?? [])
    .filter((value) => (value.displayName ?? "").length > 0)
    .map((value) => ({
      id: value.id,
      displayName: value.displayName!,
      description: value.description,
      immutable: value.immutable,
    }));

const toAttrs = (
  attribute: apihub.GoogleCloudApihubV1Attribute,
  project: string,
  region: string,
) => {
  const name = attribute.name ?? "";
  const parsed = parseResourceName(name, "attributes", region);
  return {
    name,
    attributeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: attribute.displayName,
    description: parseOwnership(attribute.description).text,
    dataType: attribute.dataType,
    scope: attribute.scope,
    cardinality: attribute.cardinality,
    allowedValues: toAllowed(attribute.allowedValues),
    mandatory: attribute.mandatory === true,
    definitionType: attribute.definitionType,
    createTime: attribute.createTime,
    updateTime: attribute.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsAttributes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const AttributeProvider = () =>
  Provider.succeed(Attribute, {
    stables: [
      "name",
      "attributeId",
      "project",
      "location",
      "dataType",
      "scope",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.attributeId ?? output?.attributeId,
        nextId: news.attributeId ?? olds?.attributeId ?? output?.attributeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (news.dataType ?? olds?.dataType) !==
            (olds?.dataType ?? output?.dataType) ||
          (news.scope ?? olds?.scope) !== (olds?.scope ?? output?.scope),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const attributeId = yield* toPhysicalId(
        id,
        olds?.attributeId,
        output?.attributeId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, attributeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listAttributes(
          locationParent(env.project, env.region),
        );
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const attributeId = yield* toPhysicalId(
        id,
        news.attributeId,
        output?.attributeId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, attributeId);
      const ownership = yield* createOwnership(id);
      const description = encodeOwnership(ownership, news.description);
      const allowedValues = news.allowedValues;
      const cardinality = news.cardinality;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsAttributes({
            parent,
            attributeId,
            body: {
              displayName: news.displayName,
              description,
              dataType: news.dataType,
              scope: news.scope,
              cardinality,
              allowedValues,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, news.displayName);
      const descriptionChanged = !sameText(current.description, description);
      const allowedChanged = !sameJson(
        toAllowed(current.allowedValues),
        allowedValues ?? [],
      );
      const cardinalityChanged =
        cardinality !== undefined && (current.cardinality ?? 1) !== cardinality;

      if (
        displayChanged ||
        descriptionChanged ||
        allowedChanged ||
        cardinalityChanged
      ) {
        current = yield* apihub.patchProjectsLocationsAttributes({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
            allowedChanged ? "allowed_values" : undefined,
            cardinalityChanged ? "cardinality" : undefined,
          ),
          body: {
            name: currentName,
            displayName: news.displayName,
            description,
            allowedValues,
            cardinality,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsAttributes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
