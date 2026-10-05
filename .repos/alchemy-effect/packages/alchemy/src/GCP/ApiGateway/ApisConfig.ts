import * as apigateway from "@distilled.cloud/gcp/apigateway_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type ApiConfigFile,
  type ApiConfigGrpcServiceDefinition,
  type ApiConfigOpenApiDocument,
  DEFAULT_LOCATION,
  encodeFiles,
  encodeGrpcServices,
  encodeOpenApiDocuments,
  expandApi,
  fieldMask,
  hasAlchemyLabelMap,
  listApis,
  listChildResources,
  listConfigs,
  locationParent,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameJson,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  ResourceFailed,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type {
  ApiConfigFile,
  ApiConfigGrpcServiceDefinition,
  ApiConfigOpenApiDocument,
};

export type ApisConfigProps = {
  /**
   * Parent API. Full name
   * `projects/{project}/locations/global/apis/{api}` or the API id.
   * Immutable — changing it replaces the config.
   */
  api: string;
  /**
   * Config id (the `{apiConfig}` segment of
   * `.../apis/{api}/configs/{apiConfig}`). If omitted, a unique RFC1035
   * id is generated. Immutable — changing it replaces the config.
   */
  apiConfigId?: string;
  /**
   * User-visible display name. Defaults to the config id.
   */
  displayName?: string;
  /**
   * OpenAPI specification documents. Mutually exclusive with
   * `grpcServices`. Immutable — changing them replaces the config.
   */
  openapiDocuments?: readonly ApiConfigOpenApiDocument[];
  /**
   * gRPC service definitions. Mutually exclusive with `openapiDocuments`.
   * Immutable — changing them replaces the config.
   */
  grpcServices?: readonly ApiConfigGrpcServiceDefinition[];
  /**
   * Service Configuration files used with gRPC service definitions.
   * Immutable — changing them replaces the config.
   */
  managedServiceConfigs?: readonly ApiConfigFile[];
  /**
   * IAM service account Gateways should use to authenticate to backends.
   * Email (`{account}@{project}.iam.gserviceaccount.com`) or full resource
   * name. Immutable — changing it replaces the config.
   */
  gatewayServiceAccount?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ApisConfig = Resource<
  "GCP.ApiGateway.ApisConfig",
  ApisConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Config id (last path segment). */
    apiConfigId: string;
    /** Parent API resource name. */
    api: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** User-visible display name. */
    displayName: string | undefined;
    /** Service account Gateways use to call backends. */
    gatewayServiceAccount: string | undefined;
    /** Associated Service Config id. */
    serviceConfigId: string | undefined;
    /** Server-reported config state. */
    state: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An API Gateway API config — OpenAPI or gRPC settings for a managed
 * API that Gateways serve.
 *
 * Parent API, config id, documents, gRPC definitions, and gateway
 * service account are immutable. Display name and labels update in
 * place. Configs live in `locations/global`.
 *
 * ### Creating an API Config
 * **Example:** OpenAPI config
 * ```typescript
 * const config = yield* GCP.ApiGateway.ApisConfig("V1", {
 *   api: api.name,
 *   displayName: "v1",
 *   openapiDocuments: [
 *     {
 *       document: {
 *         path: "openapi.yaml",
 *         contents: openApi,
 *       },
 *     },
 *   ],
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Named config
 * ```typescript
 * const config = yield* GCP.ApiGateway.ApisConfig("V1", {
 *   api: api.name,
 *   apiConfigId: "v1",
 *   openapiDocuments: [
 *     {
 *       document: {
 *         path: "openapi.yaml",
 *         contents: openApi,
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category ApiGateway
 */
export const ApisConfig = Resource<ApisConfig>("GCP.ApiGateway.ApisConfig");

const toAttrs = (
  config: apigateway.ApigatewayApiConfig,
  project: string,
  api?: string,
) => {
  const parsed = parseName(config.name ?? "", "configs");
  // API Gateway reports names with the project number; keep the project-id
  // form the parent API is addressed by so names are stable and comparable.
  const parent =
    api !== undefined && api.length > 0
      ? api
      : parsed.parent.replace(/^projects\/\d+\//, `projects/${project}/`);
  const name =
    config.name === undefined || config.name.length === 0
      ? ""
      : `${parent}/configs/${parsed.id}`;
  return {
    name,
    apiConfigId: parsed.id,
    api: parent,
    project: parseName(parent, "apis").project || project,
    location: parsed.location || DEFAULT_LOCATION,
    displayName: config.displayName,
    gatewayServiceAccount: config.gatewayServiceAccount,
    serviceConfigId: config.serviceConfigId,
    state: config.state,
    labels: userLabels(config.labels),
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apigateway
        .getProjectsLocationsApisConfigs({ name, view: "FULL" })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const documentsChanged = (
  news: ApisConfigProps,
  olds: ApisConfigProps | undefined,
) =>
  (news.openapiDocuments !== undefined &&
    olds?.openapiDocuments !== undefined &&
    !sameJson(news.openapiDocuments, olds.openapiDocuments)) ||
  (news.grpcServices !== undefined &&
    olds?.grpcServices !== undefined &&
    !sameJson(news.grpcServices, olds.grpcServices)) ||
  (news.managedServiceConfigs !== undefined &&
    olds?.managedServiceConfigs !== undefined &&
    !sameJson(news.managedServiceConfigs, olds.managedServiceConfigs));

export const ApisConfigProvider = () =>
  Provider.succeed(ApisConfig, {
    stables: [
      "name",
      "apiConfigId",
      "api",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const accountChanged =
        (olds?.gatewayServiceAccount ?? output?.gatewayServiceAccount) !==
          undefined &&
        (news.gatewayServiceAccount ?? "") !==
          (olds?.gatewayServiceAccount ?? output?.gatewayServiceAccount ?? "");
      return replaceOnIdentity({
        previousId: olds?.apiConfigId ?? output?.apiConfigId,
        nextId: news.apiConfigId ?? olds?.apiConfigId ?? output?.apiConfigId,
        previousParent:
          olds?.api !== undefined
            ? expandApi(olds.api, env.project)
            : output?.api,
        nextParent: expandApi(news.api, env.project),
        extra: documentsChanged(news, olds) || accountChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const apiConfigId = yield* toPhysicalId(
        id,
        olds?.apiConfigId,
        output?.apiConfigId,
      );
      const api =
        olds?.api !== undefined
          ? expandApi(olds.api, env.project)
          : (output?.api ?? "");
      const name = output?.name ?? (api ? resourceName(api, apiConfigId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, api);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const apis = yield* listApis(locationParent(env.project));
        const configs = yield* listChildResources(apis, listConfigs);
        return configs
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const api = expandApi(news.api, env.project);
      const apiConfigId = yield* toPhysicalId(
        id,
        news.apiConfigId,
        output?.apiConfigId,
      );
      const name = output?.name ?? resourceName(api, apiConfigId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? apiConfigId;
      const openapiDocuments = yield* encodeOpenApiDocuments(
        news.openapiDocuments,
      );
      const grpcServices = yield* encodeGrpcServices(news.grpcServices);
      const managedServiceConfigs = yield* encodeFiles(
        news.managedServiceConfigs,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigateway
          .createProjectsLocationsApisConfigs({
            parent: api,
            apiConfigId,
            body: {
              displayName,
              labels: desiredLabels,
              gatewayServiceAccount: news.gatewayServiceAccount,
              openapiDocuments,
              grpcServices,
              managedServiceConfigs,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if ((current.state ?? "").toUpperCase() === "FAILED") {
        return yield* new ResourceFailed({
          name: current.name ?? name,
          state: current.state ?? "FAILED",
        });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = !sameText(current.displayName, displayName);
      const mask = fieldMask([
        labelsChanged && "labels",
        displayChanged && "displayName",
      ]);

      if (mask.length > 0) {
        const operation = yield* apigateway.patchProjectsLocationsApisConfigs({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            displayName,
            labels: desiredLabels,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
        if ((current.state ?? "").toUpperCase() === "FAILED") {
          return yield* new ResourceFailed({
            name: current.name ?? name,
            state: current.state ?? "FAILED",
          });
        }
      }

      return toAttrs(current, env.project, api);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apigateway
        .deleteProjectsLocationsApisConfigs({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
