import type * as agw2 from "@distilled.cloud/aws/apigatewayv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Api } from "./Api.ts";

/**
 * Request options for {@link ExportApi}. `ApiId` is resolved from the
 * bound {@link Api}; `Specification` defaults to `OAS30` (the only
 * supported value — exports are OpenAPI 3.0, HTTP APIs only).
 */
export interface ExportApiRequest extends Partial<
  Omit<agw2.ExportApiRequest, "ApiId">
> {}

/**
 * Runtime binding for exporting an HTTP API's OpenAPI 3.0 definition
 * (`apigateway:GET` on `/apis/{apiId}/exports/{specification}`).
 *
 * Bind an {@link Api} inside a function runtime to serve or snapshot the
 * live API definition — e.g. publishing your own `/openapi.json` route or
 * diffing deployed routes against the source of truth. The response
 * `body` is a byte `Stream` of the JSON (or YAML) document. Provide
 * `ApiGatewayV2.ExportApiHttp` on the Function effect to implement the
 * binding.
 *
 * @binding
 * @section Exporting API definitions
 * @example Serve the live OpenAPI document
 * ```typescript
 * // init
 * const exportApi = yield* ApiGatewayV2.ExportApi(api);
 *
 * // runtime
 * const exported = yield* exportApi({ OutputType: "JSON" });
 * const document = yield* Stream.mkString(Stream.decodeText(exported.body!));
 * ```
 */
export interface ExportApi extends Binding.Service<
  ExportApi,
  "AWS.ApiGatewayV2.ExportApi",
  <A extends Api>(
    api: A,
  ) => Effect.Effect<
    (
      request?: ExportApiRequest,
    ) => Effect.Effect<agw2.ExportApiResponse, agw2.ExportApiError>
  >
> {}
export const ExportApi = Binding.Service<ExportApi>(
  "AWS.ApiGatewayV2.ExportApi",
);
