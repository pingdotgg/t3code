import * as Effect from "effect/Effect";

/**
 * Shared scaffolding for Cognito's grouped HTTP bindings.
 *
 * NOT exported from `index.ts`. Unlike services whose capabilities are one
 * operation per `Binding.Service`, Cognito's runtime bindings are grouped
 * clients (`UserPoolAuth`, `UserPoolAdmin`, `IdentityPoolAuth`,
 * `IdentityPoolAdmin`) — many operations sharing one bound resource. The
 * boilerplate factored here is the per-method wrapper: a traced `Effect.fn`
 * named `{binding}.{method}({logicalId})` that injects the bound resource's
 * resolved identifier (`UserPoolId` / `ClientId` / `IdentityPoolId`) into
 * every request before calling the distilled operation.
 */
export const cognitoMethods = (bindingId: string, logicalId: string) => ({
  /**
   * Build a client method that merges the resolved identifier field(s) in
   * `inject` into every request. The exposed request type is the distilled
   * request with the injected keys omitted.
   */
  injecting:
    <I extends object>(inject: Effect.Effect<I>) =>
    <A extends I, O, E>(
      name: string,
      op: (input: A) => Effect.Effect<O, E>,
    ): ((request: Omit<A, keyof I>) => Effect.Effect<O, E>) =>
      Effect.fn(`${bindingId}.${name}(${logicalId})`)(function* (
        request: Omit<A, keyof I>,
      ) {
        return yield* op({ ...request, ...(yield* inject) } as unknown as A);
      }),

  /** Build a client method that passes the request through unchanged
   * (operations authorized purely by an access token in the request). */
  plain: <A, O, E>(
    name: string,
    op: (input: A) => Effect.Effect<O, E>,
  ): ((request: A) => Effect.Effect<O, E>) =>
    Effect.fn(`${bindingId}.${name}(${logicalId})`)(function* (request: A) {
      return yield* op(request);
    }),
});
