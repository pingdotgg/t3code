/**
 * Shared HTTP-binding scaffolding for the AppIntegrations service.
 * NOT exported from the service barrel — each `{Op}Http.ts` is a thin
 * one-call `Layer.effect(Cap, makeAppIntegrations*HttpBinding({ ... }))`.
 */
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { Output } from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/** Deploy-time environment handed to the `resources` IAM builder. */
export interface AppIntegrationsIamEnv {
  region: string;
  accountId: string;
}

/**
 * Build the implementation effect for a resource-scoped AppIntegrations HTTP
 * binding: resolve the resource identifier at init, grant the IAM actions on
 * the host at deploy time, and inject the identifier into every request at
 * runtime under `requestKey`.
 */
export const makeAppIntegrationsHttpBinding = <
  Res extends { LogicalId: string },
  IdKey extends string,
  WireReq extends { [K in IdKey]?: unknown },
  Out,
  Err,
  OpR,
>(options: {
  /** Capability name used in the bind sid and runtime span. */
  name: string;
  /** The distilled AppIntegrations operation backing the binding. */
  operation: Effect.Effect<
    (input: WireReq) => Effect.Effect<Out, Err>,
    never,
    OpR
  >;
  /** Wire key the resolved resource identifier is injected under. */
  requestKey: IdKey;
  /** The resource attribute used as the wire identifier. */
  identifier: (resource: Res) => Output<string, never>;
  /** IAM actions granted on the host at deploy time. */
  iamActions: string[];
  /** IAM resources the actions are granted on. */
  resources: (resource: Res, env: AppIntegrationsIamEnv) => Input<string>[];
  /**
   * Dependent actions the AppIntegrations service invokes on the caller's
   * behalf (e.g. `appflow:CreateFlow` for data-integration associations).
   * Granted on `*` in a second statement — these AWS-managed side resources
   * have no stable ARN at deploy time.
   */
  dependentActions?: string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (resource: Res) {
      const Identifier = yield* options.identifier(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          yield* host.bind`Allow(${host}, AWS.AppIntegrations.${options.name}(${resource}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: options.iamActions,
                  Resource: options.resources(resource, { region, accountId }),
                },
                ...(options.dependentActions?.length
                  ? [
                      {
                        Effect: "Allow" as const,
                        Action: options.dependentActions,
                        Resource: ["*"],
                      },
                    ]
                  : []),
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.AppIntegrations.${options.name}(${resource.LogicalId})`,
      )(function* (request?: Omit<WireReq, IdKey>) {
        // The identifier key is re-added on top of the caller's request, so
        // the widened spread is exactly a WireReq.
        return yield* op({
          ...request,
          [options.requestKey]: yield* Identifier,
        } as unknown as WireReq);
      });
    });
  });

/**
 * Build the implementation effect for an account-scoped AppIntegrations HTTP
 * binding (no resource argument): grant the IAM actions on `*` at deploy time
 * and forward requests to the operation at runtime.
 */
export const makeAppIntegrationsAccountHttpBinding = <
  WireReq,
  Out,
  Err,
  OpR,
>(options: {
  /** Capability name used in the bind sid and runtime span. */
  name: string;
  /** The distilled AppIntegrations operation backing the binding. */
  operation: Effect.Effect<
    (input: WireReq) => Effect.Effect<Out, Err>,
    never,
    OpR
  >;
  /** IAM actions granted on the host at deploy time. */
  iamActions: string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.AppIntegrations.${options.name}())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: options.iamActions,
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.AppIntegrations.${options.name}`)(function* (
        request?: WireReq,
      ) {
        // List requests are all-optional structs; an absent request is the
        // empty request.
        return yield* op((request ?? {}) as WireReq);
      });
    });
  });
