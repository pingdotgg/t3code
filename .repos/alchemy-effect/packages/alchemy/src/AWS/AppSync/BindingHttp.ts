import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/**
 * Shared scaffolding for AppSync HTTP bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in
 * this service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over
 * one of the two builders below. Everything except the operation and the
 * IAM action is boilerplate:
 *
 * - {@link makeAppSyncApiHttpBinding} — control-plane operations scoped to a
 *   bound {@link GraphqlApi} (`FlushApiCache`, `GetIntrospectionSchema`).
 *   The runtime callable injects the bound API's `apiId`.
 * - {@link makeAppSyncAccountHttpBinding} — account-level pass-through
 *   operations that bind to no resource (`EvaluateCode`).
 *
 * Both grant on `Resource: "*"` — these AppSync control-plane actions define
 * no IAM resource types (per the Service Authorization Reference), so a
 * scoped API ARN is AccessDenied. `GraphQLHttp` stays bespoke: the data
 * plane has no SDK operation, each request is a SigV4-signed POST to the
 * API's `graphqlUrl`.
 */

/**
 * Build the impl Effect for a control-plane operation scoped to a bound
 * {@link GraphqlApi}. The runtime callable injects the API's `apiId` into
 * the request; the deploy-time half grants `actions` on `*` (these actions
 * define no IAM resource types).
 */
export const makeAppSyncApiHttpBinding = <
  I extends { apiId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.AppSync.FlushApiCache`. */
  tag: string;
  /** The distilled operation; `apiId` is injected from the bound API. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (api: GraphqlApi) {
      // Outputs yield DEFERRED effects — resolving them here registers the
      // attribute on the host environment; re-yield per invocation below.
      const ApiId = yield* api.apiId;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${api}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                // These AppSync control-plane actions define no IAM resource
                // types — IAM only authorizes them against "*" (a scoped API
                // ARN is AccessDenied).
                Resource: ["*"],
              },
            ],
          });
        }
      }

      return Effect.fn(`${options.tag}(${api.LogicalId})`)(function* (
        request?: Omit<I, "apiId">,
      ) {
        return yield* op({ ...request, apiId: yield* ApiId } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level AppSync operation that binds
 * to no resource. The runtime callable passes the caller's request through
 * unchanged; the deploy-time half grants `actions` on `*` (these actions
 * define no IAM resource types).
 */
export const makeAppSyncAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.AppSync.EvaluateCode`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                // No IAM resource types defined for these actions.
                Resource: ["*"],
              },
            ],
          });
        }
      }

      return Effect.fn(options.tag)(function* (request: I) {
        return yield* op(request);
      });
    });
  });
