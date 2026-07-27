import * as appsync from "@distilled.cloud/aws/appsync";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryConcurrentModification, sanitizeAppSyncName } from "./common.ts";
import type { AppSyncDataSource } from "./DataSource.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";
import { APPSYNC_JS } from "./Resolver.ts";

export interface FunctionProps {
  /**
   * ID of the GraphQL API. Usually derived from `api.apiId` by the
   * {@link Function} wrapper.
   */
  apiId: string;
  /**
   * Name of the function (`[_A-Za-z][_0-9A-Za-z]*` — no dashes). If
   * omitted, a deterministic name is generated (dashes sanitized to
   * underscores). Names are mutable.
   */
  name?: string;
  /** Description of the function. */
  description?: string;
  /** Name of the data source this function targets. */
  dataSourceName: string;
  /**
   * `APPSYNC_JS` function code exporting `request(ctx)` and
   * `response(ctx)`. When set, the runtime defaults to APPSYNC_JS 1.0.0.
   */
  code?: string;
  /** VTL request mapping template (legacy alternative to `code`). */
  requestMappingTemplate?: string;
  /** VTL response mapping template (legacy alternative to `code`). */
  responseMappingTemplate?: string;
  /**
   * The VTL function version — only used with mapping templates.
   * @default "2018-05-29" (when templates are used)
   */
  functionVersion?: string;
  /** Maximum batch size for batched Lambda invocations (0–2000). */
  maxBatchSize?: number;
}

export interface AppSyncFunction extends Resource<
  "AWS.AppSync.Function",
  FunctionProps,
  {
    /** The API this function belongs to. */
    apiId: string;
    /** The immutable function ID (referenced by pipeline resolvers). */
    functionId: string;
    /** The function ARN. */
    functionArn: string;
    /** The function name. */
    name: string;
    /** The data source this function targets. */
    dataSourceName: string;
  },
  never,
  Providers
> {}

/**
 * An AppSync pipeline function — a reusable step composed by `PIPELINE`
 * resolvers.
 * @resource
 * @section Creating Pipeline Functions
 * @example JavaScript pipeline function over a Lambda data source
 * ```typescript
 * const step = yield* AppSync.Function("InvokeStep", {
 *   api,
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
 * // reference from a PIPELINE resolver:
 * // pipelineFunctionIds: [step.functionId]
 * ```
 */
export const FunctionResource = Resource<AppSyncFunction>(
  "AWS.AppSync.Function",
);

export interface FunctionInputProps extends Omit<
  {
    [K in keyof FunctionProps]?: Input<FunctionProps[K]>;
  },
  "apiId" | "dataSourceName"
> {
  /**
   * The `GraphqlApi` this function belongs to (preferred). Alternatively
   * pass a raw `apiId`.
   */
  api?: GraphqlApi;
  apiId?: Input<string>;
  /**
   * The data source this function targets (preferred). Alternatively pass
   * a raw `dataSourceName`.
   */
  dataSource?: AppSyncDataSource;
  dataSourceName?: Input<string>;
}

/**
 * User-facing wrapper for the pipeline Function resource. Accepts
 * `api: GraphqlApi` and `dataSource: DataSource` directly.
 */
export const Function = (id: string, props: FunctionInputProps) =>
  Effect.gen(function* () {
    const { api, dataSource, ...rest } = props;
    const apiId = rest.apiId ?? api?.apiId;
    if (!apiId) {
      return yield* Effect.die(
        "AppSync.Function requires either `api` (preferred) or an explicit `apiId`.",
      );
    }
    const dataSourceName = rest.dataSourceName ?? dataSource?.name;
    if (!dataSourceName) {
      return yield* Effect.die(
        "AppSync.Function requires either `dataSource` (preferred) or an explicit `dataSourceName`.",
      );
    }
    return yield* FunctionResource(id, {
      ...rest,
      apiId,
      dataSourceName,
    } as any);
  });

export const FunctionProvider = () =>
  Provider.effect(
    FunctionResource,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<FunctionProps, "name">,
      ) {
        return (
          props.name ??
          sanitizeAppSyncName(yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getFunctionSafe = (apiId: string, functionId: string) =>
        appsync.getFunction({ apiId, functionId }).pipe(
          Effect.map((response) => response.functionConfiguration),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      /** Find a function by name (fallback when no functionId is cached). */
      const findFunctionByName = Effect.fn(function* (
        apiId: string,
        name: string,
      ) {
        const pages = yield* appsync.listFunctions.pages({ apiId }).pipe(
          Stream.runCollect,
          Effect.catchTag("NotFoundException", () => Effect.succeed([])),
        );
        return Array.from(pages)
          .flatMap((page) => page.functions ?? [])
          .find((fn) => fn.name === name);
      });

      const desiredWire = (news: FunctionProps, name: string) => ({
        name,
        description: news.description,
        dataSourceName: news.dataSourceName,
        code: news.code,
        runtime: news.code !== undefined ? APPSYNC_JS : undefined,
        requestMappingTemplate: news.requestMappingTemplate,
        responseMappingTemplate: news.responseMappingTemplate,
        functionVersion:
          news.functionVersion ??
          (news.code === undefined ? "2018-05-29" : undefined),
        maxBatchSize: news.maxBatchSize,
      });

      const surface = (fn: {
        name?: string;
        description?: string;
        dataSourceName?: string;
        code?: string;
        runtime?: appsync.AppSyncRuntime;
        requestMappingTemplate?: string;
        responseMappingTemplate?: string;
        maxBatchSize?: number;
      }) =>
        JSON.parse(
          JSON.stringify({
            name: fn.name,
            description: fn.description,
            dataSourceName: fn.dataSourceName,
            code: fn.code,
            runtime: fn.runtime,
            requestMappingTemplate: fn.requestMappingTemplate,
            responseMappingTemplate: fn.responseMappingTemplate,
            maxBatchSize: fn.maxBatchSize ?? 0,
          }),
        );

      const toAttributes = (
        apiId: string,
        fn: appsync.FunctionConfiguration,
      ): AppSyncFunction["Attributes"] => ({
        apiId,
        functionId: fn.functionId!,
        functionArn: fn.functionArn!,
        name: fn.name!,
        dataSourceName: fn.dataSourceName!,
      });

      return FunctionResource.Provider.of({
        stables: ["apiId", "functionId", "functionArn"],

        // Sub-resource keyed entirely by its GraphQL API (apiId) with no global
        // enumeration API of its own — nuke reaches it through the parent's
        // deletion, so enumeration returns empty per the ProviderService
        // doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const apiId = output?.apiId ?? olds?.apiId;
          if (apiId === undefined) return undefined;
          const fn =
            output?.functionId !== undefined
              ? yield* getFunctionSafe(apiId, output.functionId)
              : yield* findFunctionByName(
                  apiId,
                  yield* createName(id, olds ?? {}),
                );
          if (fn?.functionId == null) return undefined;
          return toAttributes(apiId, fn);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.apiId !== olds.apiId) {
            return { action: "replace" } as const;
          }
          // name/code/data source converge via updateFunction
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const apiId = output?.apiId ?? news.apiId;
          const name = news.name ?? (yield* createName(id, news));
          const desired = desiredWire(news, name);

          // 1. OBSERVE — functionId cache first, then name scan.
          let observed =
            output?.functionId !== undefined
              ? yield* getFunctionSafe(apiId, output.functionId)
              : yield* findFunctionByName(apiId, name);

          if (observed?.functionId == null) {
            // 2. ENSURE
            const created = yield* retryConcurrentModification(
              appsync.createFunction({ apiId, ...desired }),
            );
            observed = created.functionConfiguration!;
            yield* session.note(`Created pipeline function ${name}`);
          } else if (!deepEqual(surface(observed), surface(desired))) {
            // 3. SYNC
            const updated = yield* retryConcurrentModification(
              appsync.updateFunction({
                apiId,
                functionId: observed.functionId,
                ...desired,
              }),
            );
            observed = updated.functionConfiguration ?? observed;
            yield* session.note(`Updated pipeline function ${name}`);
          }

          yield* session.note(name);
          return toAttributes(apiId, observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrentModification(
            appsync
              .deleteFunction({
                apiId: output.apiId,
                functionId: output.functionId,
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
        }),
      });
    }),
  );
