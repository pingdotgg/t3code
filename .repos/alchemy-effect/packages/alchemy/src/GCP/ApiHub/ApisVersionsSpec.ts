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
  type AttributeValues,
  type AttributeValuesMap,
  type Documentation,
  MAX_DISPLAY_NAME_LENGTH,
  createOwnership,
  encodeContents,
  encodeOwnershipLine,
  hasOwnershipMarker,
  listApis,
  listChildResources,
  listSpecs,
  listVersions,
  normalizeLocation,
  openApiSpecType,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
} from "./internal.ts";

export type SpecContents = {
  /**
   * Spec document. Raw UTF-8 is base64-encoded before it is sent.
   */
  contents: string;
  /**
   * MIME type (`application/yaml`, `application/json`, …).
   */
  mimeType: string;
};

export type ApisVersionsSpecProps = {
  /**
   * Parent version. Full name
   * `projects/{project}/locations/{location}/apis/{api}/versions/{version}`.
   * Immutable — changing it replaces the spec.
   */
  version: string;
  /**
   * Spec id (the `{spec}` segment of
   * `.../versions/{version}/specs/{spec}`). If omitted, a unique id is
   * generated. Immutable — changing it replaces the spec.
   */
  specId?: string;
  /**
   * Location used when parsing parent names.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (often the file name). Specs have no labels field, so
   * Alchemy stamps ownership into this field for `list` / nuke.
   */
  displayName?: string;
  /**
   * URI of the spec in an external version-control system.
   */
  sourceUri?: string;
  /**
   * Spec document. Required on create when `sourceUri` is omitted.
   * Input-only — subsequent updates send a new document when this field
   * changes.
   */
  contents?: SpecContents;
  /**
   * Spec type. Defaults to the system OpenAPI enum when `contents` is
   * provided.
   */
  specType?: AttributeValues;
  /**
   * OpenAPI parsing mode.
   */
  parsingMode?:
    | "PARSING_MODE_UNSPECIFIED"
    | "RELAXED"
    | "STRICT"
    | (string & {});
  /**
   * External documentation.
   */
  documentation?: Documentation;
  /**
   * User-defined attributes keyed by attribute resource name.
   */
  attributes?: AttributeValuesMap;
};

export type ApisVersionsSpec = Resource<
  "GCP.ApiHub.ApisVersionsSpec",
  ApisVersionsSpecProps,
  {
    /** Full resource name. */
    name: string;
    /** Spec id (last path segment). */
    specId: string;
    /** Parent version resource name. */
    version: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Source URI. */
    sourceUri: string | undefined;
    /** Spec type. */
    specType: AttributeValues | undefined;
    /** Parsed spec details. */
    details: apihub.GoogleCloudApihubV1SpecDetails | undefined;
    /** Documentation. */
    documentation: Documentation | undefined;
    /** User-defined attributes. */
    attributes: AttributeValuesMap | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A spec attached to an API Hub version. Adding an OpenAPI spec parses
 * operations onto the version.
 *
 * Parent version and id are immutable. Display name, source URI, contents,
 * spec type, and attributes update in place. Specs have no labels field —
 * Alchemy stamps ownership into the display name.
 *
 * ### Creating a Spec
 * **Example:** OpenAPI YAML
 * ```typescript
 * const spec = yield* GCP.ApiHub.ApisVersionsSpec("OpenApi", {
 *   version: version.name,
 *   displayName: "openapi.yaml",
 *   contents: {
 *     contents: "openapi: 3.0.0\ninfo:\n  title: pets\n  version: 1.0.0\npaths: {}\n",
 *     mimeType: "application/yaml",
 *   },
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const ApisVersionsSpec = Resource<ApisVersionsSpec>(
  "GCP.ApiHub.ApisVersionsSpec",
);

const resourceName = (version: string, specId: string) =>
  `${version}/specs/${specId}`;

const toAttrs = (
  spec: apihub.GoogleCloudApihubV1Spec,
  project: string,
  region: string,
): ApisVersionsSpec["Attributes"] => {
  const name = spec.name ?? "";
  const parsed = parseResourceName(name, "specs", region);
  return {
    name,
    specId: parsed.id,
    version: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: parseOwnership(spec.displayName).text,
    sourceUri: spec.sourceUri,
    specType: spec.specType,
    details: spec.details,
    documentation: spec.documentation,
    attributes: spec.attributes,
    createTime: spec.createTime,
    updateTime: spec.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsApisVersionsSpecs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ApisVersionsSpecProvider = () =>
  Provider.succeed(ApisVersionsSpec, {
    stables: ["name", "specId", "version", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.specId ?? output?.specId,
        nextId: news.specId ?? olds?.specId ?? output?.specId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.version ?? output?.version,
        nextParent: news.version ?? olds?.version ?? output?.version,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const version = olds?.version ?? output?.version ?? "";
      const specId = yield* toPhysicalId(id, olds?.specId, output?.specId);
      const name = output?.name ?? resourceName(version, specId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const apis = yield* listApis(
          `projects/${env.project}/locations/${env.region}`,
        );
        const versions = yield* listChildResources(apis, listVersions);
        const specs = yield* listChildResources(versions, listSpecs);
        return specs
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const version = news.version.replace(/\/+$/, "");
      const specId = yield* toPhysicalId(id, news.specId, output?.specId);
      const name = output?.name ?? resourceName(version, specId);
      const ownership = yield* createOwnership(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? specId,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const specType =
        news.specType ??
        (news.contents ? openApiSpecType(env.project, location) : undefined);
      const encodedContents =
        news.contents === undefined
          ? undefined
          : {
              contents: yield* encodeContents(news.contents.contents),
              mimeType: news.contents.mimeType,
            };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsApisVersionsSpecs({
            parent: version,
            specId,
            body: {
              displayName,
              sourceUri: news.sourceUri,
              contents: encodedContents,
              specType,
              parsingMode: news.parsingMode,
              documentation: news.documentation,
              attributes: news.attributes,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ApihubNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const sourceChanged = !sameText(current.sourceUri, news.sourceUri);
      const contentsChanged =
        news.contents !== undefined && !sameJson(news.contents, olds?.contents);
      const typeChanged =
        specType !== undefined && !sameJson(current.specType, specType);
      const attributesChanged = !sameJson(current.attributes, news.attributes);

      if (
        displayChanged ||
        sourceChanged ||
        contentsChanged ||
        (contentsChanged && typeChanged) ||
        attributesChanged
      ) {
        current = yield* apihub.patchProjectsLocationsApisVersionsSpecs({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            sourceChanged ? "source_uri" : undefined,
            contentsChanged ? "contents" : undefined,
            contentsChanged || typeChanged ? "spec_type" : undefined,
            attributesChanged ? "attributes" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            sourceUri: news.sourceUri,
            contents: contentsChanged ? encodedContents : undefined,
            specType: contentsChanged || typeChanged ? specType : undefined,
            attributes: news.attributes,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsApisVersionsSpecs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
