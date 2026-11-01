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
  type AttributeValuesMap,
  type Documentation,
  createOwnership,
  encodeOwnership,
  hasOwnershipMarker,
  listApis,
  listChildResources,
  listOperations,
  listVersions,
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

export type HttpOperation = {
  /** HTTP method. Required on create. */
  method?:
    | "METHOD_UNSPECIFIED"
    | "GET"
    | "PUT"
    | "POST"
    | "DELETE"
    | "OPTIONS"
    | "HEAD"
    | "PATCH"
    | "TRACE"
    | (string & {});
  /** Path relative to the server endpoint. Required on create. */
  path?: {
    path?: string;
    description?: string;
  };
};

export type OperationDetails = {
  /** HTTP operation. Required on create when not using MCP. */
  httpOperation?: HttpOperation;
  /** Description of the operation. Alchemy stamps ownership here. */
  description?: string;
  /** When true, the operation is deprecated. */
  deprecated?: boolean;
  /** External documentation. */
  documentation?: Documentation;
  /** MCP tool details. */
  mcpTool?: apihub.GoogleCloudApihubV1McpTool;
};

export type ApisVersionsOperationProps = {
  /**
   * Parent version. Full name
   * `projects/{project}/locations/{location}/apis/{api}/versions/{version}`.
   * Immutable — changing it replaces the operation.
   */
  version: string;
  /**
   * Operation id (the `{operation}` segment of
   * `.../versions/{version}/operations/{operation}`). If omitted, a unique
   * id is generated. Immutable — changing it replaces the operation.
   */
  apiOperationId?: string;
  /**
   * Location used when parsing parent names.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Operation details. `httpOperation.method` and `httpOperation.path.path`
   * are required on create. Description is stamped with `[alchemy …]`
   * because operations have no labels field.
   */
  details: OperationDetails;
  /**
   * User-defined attributes keyed by attribute resource name.
   */
  attributes?: AttributeValuesMap;
};

export type ApisVersionsOperation = Resource<
  "GCP.ApiHub.ApisVersionsOperation",
  ApisVersionsOperationProps,
  {
    /** Full resource name. */
    name: string;
    /** Operation id (last path segment). */
    apiOperationId: string;
    /** Parent version resource name. */
    version: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Spec that produced this operation, if parsed from a spec. */
    spec: string | undefined;
    /** Operation details with the Alchemy ownership prefix stripped. */
    details: OperationDetails | undefined;
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
 * An API operation in an API Hub version. Operations can be created only
 * when the version has no spec-parsed operations.
 *
 * Parent version and id are immutable. Description, documentation, HTTP
 * path/method, deprecation, and attributes update in place. Operations
 * have no labels field — Alchemy stamps ownership into
 * `details.description`.
 *
 * ### Creating an Operation
 * **Example:** GET /pets
 * ```typescript
 * const version = yield* GCP.ApiHub.ApisVersion("V1", { api: api.name });
 * const operation = yield* GCP.ApiHub.ApisVersionsOperation("ListPets", {
 *   version: version.name,
 *   details: {
 *     httpOperation: { method: "GET", path: { path: "/pets" } },
 *     description: "list pets",
 *   },
 * });
 * ```
 *
 * @resource
 * @category ApiHub
 */
export const ApisVersionsOperation = Resource<ApisVersionsOperation>(
  "GCP.ApiHub.ApisVersionsOperation",
);

const resourceName = (version: string, apiOperationId: string) =>
  `${version}/operations/${apiOperationId}`;

const toDetails = (
  details: apihub.GoogleCloudApihubV1OperationDetails | undefined,
): OperationDetails | undefined => {
  if (details === undefined) return undefined;
  const parsed = parseOwnership(details.description);
  return {
    httpOperation: details.httpOperation,
    description: parsed.text,
    deprecated: details.deprecated,
    documentation: details.documentation,
    mcpTool: details.mcpTool,
  };
};

const toAttrs = (
  operation: apihub.GoogleCloudApihubV1ApiOperation,
  project: string,
  region: string,
): ApisVersionsOperation["Attributes"] => {
  const name = operation.name ?? "";
  const parsed = parseResourceName(name, "operations", region);
  return {
    name,
    apiOperationId: parsed.id,
    version: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    spec: operation.spec,
    details: toDetails(operation.details),
    attributes: operation.attributes,
    createTime: operation.createTime,
    updateTime: operation.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apihub
        .getProjectsLocationsApisVersionsOperations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const detailsOf = (
  news: ApisVersionsOperationProps,
  description: string,
): apihub.GoogleCloudApihubV1OperationDetails => ({
  httpOperation: news.details.httpOperation,
  description,
  deprecated: news.details.deprecated,
  documentation: news.details.documentation,
  mcpTool: news.details.mcpTool,
});

export const ApisVersionsOperationProvider = () =>
  Provider.succeed(ApisVersionsOperation, {
    stables: [
      "name",
      "apiOperationId",
      "version",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.apiOperationId ?? output?.apiOperationId,
        nextId:
          news.apiOperationId ?? olds?.apiOperationId ?? output?.apiOperationId,
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
      const apiOperationId = yield* toPhysicalId(
        id,
        olds?.apiOperationId,
        output?.apiOperationId,
      );
      const name = output?.name ?? resourceName(version, apiOperationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.details?.description))
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
        const operations = yield* listChildResources(versions, listOperations);
        return operations
          .filter((item) => hasOwnershipMarker(item.details?.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const version = news.version.replace(/\/+$/, "");
      const apiOperationId = yield* toPhysicalId(
        id,
        news.apiOperationId,
        output?.apiOperationId,
      );
      const name = output?.name ?? resourceName(version, apiOperationId);
      const ownership = yield* createOwnership(id);
      const description = encodeOwnership(ownership, news.details.description);
      const details = detailsOf(news, description);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* apihub
          .createProjectsLocationsApisVersionsOperations({
            parent: version,
            apiOperationId,
            body: {
              details,
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
      const descriptionChanged = !sameText(
        current.details?.description,
        description,
      );
      const docsChanged = !sameJson(
        current.details?.documentation,
        news.details.documentation,
      );
      const pathChanged = !sameJson(
        current.details?.httpOperation?.path,
        news.details.httpOperation?.path,
      );
      const methodChanged = !sameText(
        current.details?.httpOperation?.method,
        news.details.httpOperation?.method,
      );
      const deprecatedChanged =
        (current.details?.deprecated === true) !==
        (news.details.deprecated === true);
      const mcpChanged = !sameJson(
        current.details?.mcpTool,
        news.details.mcpTool,
      );
      const attributesChanged = !sameJson(current.attributes, news.attributes);

      if (
        descriptionChanged ||
        docsChanged ||
        pathChanged ||
        methodChanged ||
        deprecatedChanged ||
        mcpChanged ||
        attributesChanged
      ) {
        current = yield* apihub.patchProjectsLocationsApisVersionsOperations({
          name: currentName,
          updateMask: updateMaskOf(
            descriptionChanged ? "details.description" : undefined,
            docsChanged ? "details.documentation" : undefined,
            pathChanged ? "details.http_operation.path" : undefined,
            methodChanged ? "details.http_operation.method" : undefined,
            deprecatedChanged ? "details.deprecated" : undefined,
            mcpChanged ? "details.mcp_tool" : undefined,
            attributesChanged ? "attributes" : undefined,
          ),
          body: {
            name: currentName,
            details,
            attributes: news.attributes,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apihub
        .deleteProjectsLocationsApisVersionsOperations({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
