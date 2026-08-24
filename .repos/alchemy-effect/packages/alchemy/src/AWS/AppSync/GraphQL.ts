import type * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/**
 * The GraphQL endpoint returned a non-2xx response or an unparseable body.
 * GraphQL *field* errors do NOT fail the effect — they are surfaced on
 * {@link GraphQLResult.errors} alongside any partial `data`.
 */
export class GraphQLApiError extends Data.TaggedError("GraphQLApiError")<{
  /** HTTP status of the failed request (0 when the request never left). */
  readonly status: number;
  /** The raw response body (or the underlying failure message). */
  readonly body: string;
}> {}

/** A single entry of the standard GraphQL `errors` array. */
export interface GraphQLErrorItem {
  message: string;
  path?: ReadonlyArray<string | number>;
  locations?: ReadonlyArray<{ line: number; column: number }>;
  errorType?: string;
  [key: string]: unknown;
}

/** The standard GraphQL response envelope. */
export interface GraphQLResult<T = unknown> {
  /** The (possibly partial) result data. */
  data?: T;
  /** GraphQL field/validation errors, if any. */
  errors?: ReadonlyArray<GraphQLErrorItem>;
  extensions?: Record<string, unknown>;
}

/** A GraphQL operation to execute against the API. */
export interface GraphQLRequest {
  /** The GraphQL document, e.g. `query($a: Int!) { add(a: $a, b: 1) }`. */
  query: string;
  /** Values for the document's variables. */
  variables?: Record<string, unknown>;
  /** Which operation to run when the document defines several. */
  operationName?: string;
}

export interface GraphQLClient {
  /**
   * Execute a GraphQL operation (query or mutation), SigV4-signed with the
   * host Function's credentials. Fails only on transport/HTTP errors —
   * GraphQL field errors are returned on `result.errors`.
   */
  execute<T = unknown>(
    request: GraphQLRequest,
  ): Effect.Effect<
    GraphQLResult<T>,
    GraphQLApiError | Credentials.CredentialsError
  >;
}

/**
 * Runtime binding for the `appsync:GraphQL` data-plane action — execute
 * GraphQL operations against a {@link GraphqlApi}'s endpoint from a Lambda
 * (or other AWS runtime), SigV4-signed with the host Function's IAM role.
 *
 * The API must accept `AWS_IAM` authentication (as its primary mode or an
 * additional provider). Provide `AppSync.GraphQLHttp` on the hosting
 * function's Effect to implement the binding.
 *
 * @binding
 * @section Executing GraphQL Operations
 * @example Query an IAM-authenticated API
 * ```typescript
 * const api = yield* AppSync.GraphqlApi("Api", {
 *   authenticationType: "AWS_IAM",
 *   schema,
 * });
 * const graphql = yield* AppSync.GraphQL(api);
 *
 * const result = yield* graphql.execute<{ add: number }>({
 *   query: "query($a: Int!, $b: Int!) { add(a: $a, b: $b) }",
 *   variables: { a: 2, b: 3 },
 * });
 * // result.data?.add === 5; field errors appear on result.errors
 * ```
 */
export interface GraphQL extends Binding.Service<
  GraphQL,
  "AWS.AppSync.GraphQL",
  (api: GraphqlApi) => Effect.Effect<GraphQLClient>
> {}
export const GraphQL = Binding.Service<GraphQL>("AWS.AppSync.GraphQL");
