import type * as appsync from "@distilled.cloud/aws/appsync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/**
 * Runtime binding for `appsync:GetIntrospectionSchema` — read a
 * {@link GraphqlApi}'s live schema (SDL or introspection JSON) from a Lambda
 * (or other AWS runtime), e.g. for schema registries, codegen services, or
 * federation gateways that discover the schema at runtime.
 *
 * The response `schema` is a streaming body — collect it with
 * `Stream.mkString(Stream.decodeText(response.schema!))`. Provide
 * `AppSync.GetIntrospectionSchemaHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * @binding
 * @section Reading the Schema
 * @example Fetch the API's SDL at runtime
 * ```typescript
 * const getSchema = yield* AppSync.GetIntrospectionSchema(api);
 *
 * const response = yield* getSchema({ format: "SDL" });
 * const sdl = yield* Stream.mkString(Stream.decodeText(response.schema!));
 * ```
 */
export interface GetIntrospectionSchema extends Binding.Service<
  GetIntrospectionSchema,
  "AWS.AppSync.GetIntrospectionSchema",
  (
    api: GraphqlApi,
  ) => Effect.Effect<
    (
      request: Omit<appsync.GetIntrospectionSchemaRequest, "apiId">,
    ) => Effect.Effect<
      appsync.GetIntrospectionSchemaResponse,
      appsync.GetIntrospectionSchemaError
    >
  >
> {}
export const GetIntrospectionSchema = Binding.Service<GetIntrospectionSchema>(
  "AWS.AppSync.GetIntrospectionSchema",
);
