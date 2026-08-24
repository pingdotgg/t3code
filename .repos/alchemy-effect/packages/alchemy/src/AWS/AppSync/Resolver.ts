import * as appsync from "@distilled.cloud/aws/appsync";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryConcurrentModification } from "./common.ts";
import type { AppSyncDataSource } from "./DataSource.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/** The modern JavaScript resolver runtime. */
export const APPSYNC_JS: appsync.AppSyncRuntime = {
  name: "APPSYNC_JS",
  runtimeVersion: "1.0.0",
};

export interface ResolverProps {
  /**
   * ID of the GraphQL API. Usually derived from `api.apiId` by the
   * {@link Resolver} wrapper.
   */
  apiId: string;
  /**
   * The schema type the resolver is attached to (e.g. `Query`,
   * `Mutation`, or an object type). Changing it triggers a replacement.
   */
  typeName: string;
  /**
   * The field on {@link ResolverProps.typeName} this resolver serves.
   * Changing it triggers a replacement.
   */
  fieldName: string;
  /**
   * Name of the data source a `UNIT` resolver targets. Not used by
   * `PIPELINE` resolvers.
   */
  dataSourceName?: string;
  /**
   * The resolver kind.
   * @default "UNIT"
   */
  kind?: "UNIT" | "PIPELINE";
  /**
   * `APPSYNC_JS` resolver code exporting `request(ctx)` and
   * `response(ctx)`. When set, the runtime defaults to APPSYNC_JS 1.0.0.
   */
  code?: string;
  /** VTL request mapping template (legacy alternative to `code`). */
  requestMappingTemplate?: string;
  /** VTL response mapping template (legacy alternative to `code`). */
  responseMappingTemplate?: string;
  /**
   * Pipeline function IDs executed in order — required for `PIPELINE`
   * resolvers. Pass `fn.functionId` outputs from {@link Function}.
   */
  pipelineFunctionIds?: string[];
  /** Maximum batch size for batched Lambda invocations (0–2000). */
  maxBatchSize?: number;
  /** Per-resolver caching config (requires an API cache). */
  cachingConfig?: appsync.CachingConfig;
}

export interface AppSyncResolver extends Resource<
  "AWS.AppSync.Resolver",
  ResolverProps,
  {
    /** The API this resolver belongs to. */
    apiId: string;
    /** The schema type the resolver is attached to. */
    typeName: string;
    /** The field the resolver serves. */
    fieldName: string;
    /** The resolver ARN. */
    resolverArn: string;
    /** The data source a UNIT resolver targets. */
    dataSourceName: string | undefined;
    /** The resolver kind. */
    kind: "UNIT" | "PIPELINE";
  },
  never,
  Providers
> {}

/**
 * An AppSync resolver — attaches request/response logic to a schema field.
 *
 * `UNIT` resolvers target a single data source; `PIPELINE` resolvers run a
 * sequence of {@link Function}s. The modern default is `APPSYNC_JS` code
 * (a module exporting `request(ctx)` / `response(ctx)`); VTL mapping
 * templates remain supported.
 * @resource
 * @section Unit Resolvers
 * @example JavaScript unit resolver over a Lambda data source
 * ```typescript
 * const resolver = yield* AppSync.Resolver("AddResolver", {
 *   api,
 *   typeName: "Query",
 *   fieldName: "add",
 *   dataSource: lambdaDS,
 *   code: `
 *     export function request(ctx) {
 *       return { operation: "Invoke", payload: { args: ctx.args } };
 *     }
 *     export function response(ctx) {
 *       return ctx.result;
 *     }
 *   `,
 * });
 * ```
 *
 * @section Pipeline Resolvers
 * @example Pipeline resolver running one function
 * ```typescript
 * const fn = yield* AppSync.Function("Step", {
 *   api,
 *   dataSource: lambdaDS,
 *   code: fnCode,
 * });
 * const resolver = yield* AppSync.Resolver("PipelineResolver", {
 *   api,
 *   typeName: "Query",
 *   fieldName: "double",
 *   kind: "PIPELINE",
 *   pipelineFunctionIds: [fn.functionId],
 *   code: `
 *     export function request(ctx) { return {}; }
 *     export function response(ctx) { return ctx.prev.result; }
 *   `,
 * });
 * ```
 */
export const ResolverResource = Resource<AppSyncResolver>(
  "AWS.AppSync.Resolver",
);

export interface ResolverInputProps extends Omit<
  {
    [K in keyof ResolverProps]?: Input<ResolverProps[K]>;
  },
  "apiId" | "typeName" | "fieldName" | "dataSourceName"
> {
  /**
   * The `GraphqlApi` this resolver belongs to (preferred). Alternatively
   * pass a raw `apiId`.
   */
  api?: GraphqlApi;
  apiId?: Input<string>;
  typeName: Input<string>;
  fieldName: Input<string>;
  /**
   * The data source a UNIT resolver targets (preferred). Alternatively
   * pass a raw `dataSourceName`.
   */
  dataSource?: AppSyncDataSource;
  dataSourceName?: Input<string>;
}

/**
 * User-facing wrapper for the Resolver resource. Accepts `api: GraphqlApi`
 * and `dataSource: DataSource` as the idiomatic way to wire a resolver.
 */
export const Resolver = (id: string, props: ResolverInputProps) =>
  Effect.gen(function* () {
    const { api, dataSource, ...rest } = props;
    const apiId = rest.apiId ?? api?.apiId;
    if (!apiId) {
      return yield* Effect.die(
        "Resolver requires either `api` (preferred) or an explicit `apiId`.",
      );
    }
    const dataSourceName = rest.dataSourceName ?? dataSource?.name;
    return yield* ResolverResource(id, {
      ...rest,
      apiId,
      dataSourceName,
    } as any);
  });

export const ResolverProvider = () =>
  Provider.effect(
    ResolverResource,
    Effect.gen(function* () {
      const getResolverSafe = (
        apiId: string,
        typeName: string,
        fieldName: string,
      ) =>
        appsync.getResolver({ apiId, typeName, fieldName }).pipe(
          Effect.map((response) => response.resolver),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      const desiredWire = (news: ResolverProps) => ({
        dataSourceName: news.dataSourceName,
        kind: news.kind ?? "UNIT",
        code: news.code,
        runtime: news.code !== undefined ? APPSYNC_JS : undefined,
        requestMappingTemplate: news.requestMappingTemplate,
        responseMappingTemplate: news.responseMappingTemplate,
        pipelineConfig:
          news.pipelineFunctionIds === undefined
            ? undefined
            : { functions: news.pipelineFunctionIds },
        maxBatchSize: news.maxBatchSize,
        cachingConfig: news.cachingConfig,
      });

      const surface = (resolver: {
        dataSourceName?: string;
        kind?: string;
        code?: string;
        runtime?: appsync.AppSyncRuntime;
        requestMappingTemplate?: string;
        responseMappingTemplate?: string;
        pipelineConfig?: appsync.PipelineConfig;
        maxBatchSize?: number;
        cachingConfig?: appsync.CachingConfig;
      }) =>
        JSON.parse(
          JSON.stringify({
            dataSourceName: resolver.dataSourceName,
            kind: resolver.kind ?? "UNIT",
            code: resolver.code,
            runtime: resolver.runtime,
            requestMappingTemplate: resolver.requestMappingTemplate,
            responseMappingTemplate: resolver.responseMappingTemplate,
            pipelineFunctions: resolver.pipelineConfig?.functions ?? [],
            maxBatchSize: resolver.maxBatchSize ?? 0,
            cachingConfig: resolver.cachingConfig,
          }),
        );

      const toAttributes = (
        apiId: string,
        resolver: appsync.Resolver,
      ): AppSyncResolver["Attributes"] => ({
        apiId,
        typeName: resolver.typeName!,
        fieldName: resolver.fieldName!,
        resolverArn: resolver.resolverArn!,
        dataSourceName: resolver.dataSourceName,
        kind: (resolver.kind ?? "UNIT") as "UNIT" | "PIPELINE",
      });

      return ResolverResource.Provider.of({
        stables: ["apiId", "typeName", "fieldName", "resolverArn"],

        // Sub-resource keyed entirely by its GraphQL API (apiId/typeName) with no global
        // enumeration API of its own — nuke reaches it through the parent's
        // deletion, so enumeration returns empty per the ProviderService
        // doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const apiId = output?.apiId ?? olds?.apiId;
          const typeName = output?.typeName ?? olds?.typeName;
          const fieldName = output?.fieldName ?? olds?.fieldName;
          if (
            apiId === undefined ||
            typeName === undefined ||
            fieldName === undefined
          ) {
            return undefined;
          }
          const resolver = yield* getResolverSafe(apiId, typeName, fieldName);
          if (resolver?.resolverArn == null) return undefined;
          return toAttributes(apiId, resolver);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.apiId !== olds.apiId ||
            news.typeName !== olds.typeName ||
            news.fieldName !== olds.fieldName
          ) {
            return { action: "replace" } as const;
          }
          // data source / code / kind / pipeline converge via update
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const apiId = output?.apiId ?? news.apiId;
          const typeName = news.typeName;
          const fieldName = news.fieldName;
          const desired = desiredWire(news);

          // 1. OBSERVE
          let observed = yield* getResolverSafe(apiId, typeName, fieldName);

          if (observed?.resolverArn == null) {
            // 2. ENSURE
            const created = yield* retryConcurrentModification(
              appsync.createResolver({
                apiId,
                typeName,
                fieldName,
                ...desired,
              }),
            );
            observed = created.resolver!;
            yield* session.note(`Created resolver ${typeName}.${fieldName}`);
          } else if (!deepEqual(surface(observed), surface(desired))) {
            // 3. SYNC
            const updated = yield* retryConcurrentModification(
              appsync.updateResolver({
                apiId,
                typeName,
                fieldName,
                ...desired,
              }),
            );
            observed = updated.resolver ?? observed;
            yield* session.note(`Updated resolver ${typeName}.${fieldName}`);
          }

          yield* session.note(`${typeName}.${fieldName}`);
          return toAttributes(apiId, observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrentModification(
            appsync
              .deleteResolver({
                apiId: output.apiId,
                typeName: output.typeName,
                fieldName: output.fieldName,
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
        }),
      });
    }),
  );
