import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Application } from "./Application.ts";
import type { AttributeGroup } from "./AttributeGroup.ts";

/**
 * Shared scaffolding for AppRegistry HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the three
 * builders below. Everything except the operation, the IAM action list, and
 * the injected identifier is boilerplate.
 *
 * AppRegistry IAM actions live under the `servicecatalog:` service prefix.
 */

/**
 * Build the impl Effect for an application-scoped operation: the runtime
 * callable injects the bound {@link Application}'s ID as `application` and
 * the deploy-time half grants `actions` on the application ARN.
 */
export const makeApplicationScopedHttpBinding = <
  I extends { application: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.AppRegistry.GetApplication`. */
  tag: string;
  /** The distilled operation; `application` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the application ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (application: Application) {
      const ApplicationId = yield* application.applicationId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${application}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${application.applicationArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${application.LogicalId})`)(function* (
        request?: Omit<I, "application">,
      ) {
        return yield* op({
          ...request,
          application: yield* ApplicationId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an attribute-group-scoped operation: the runtime
 * callable injects the bound {@link AttributeGroup}'s ID as `attributeGroup`
 * and the deploy-time half grants `actions` on the attribute group ARN.
 */
export const makeAttributeGroupScopedHttpBinding = <
  I extends { attributeGroup: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.AppRegistry.GetAttributeGroup`. */
  tag: string;
  /** The distilled operation; `attributeGroup` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the attribute group ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (attributeGroup: AttributeGroup) {
      const AttributeGroupId = yield* attributeGroup.attributeGroupId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${attributeGroup}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${attributeGroup.attributeGroupArn}`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${attributeGroup.LogicalId})`)(
        function* (request?: Omit<I, "attributeGroup">) {
          return yield* op({
            ...request,
            attributeGroup: yield* AttributeGroupId,
          } as I);
        },
      );
    });
  });

/**
 * Build the impl Effect for an account-level operation (no target resource).
 * The deploy-time half grants `actions` on `*`.
 */
export const makeAppRegistryAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.AppRegistry.SyncResource`. */
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
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
