import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Discoverer } from "./Discoverer.ts";
import type { Registry } from "./Registry.ts";
import type { Schema } from "./Schema.ts";

/**
 * Shared scaffolding for EventBridge Schemas HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the identifier resolver, and the
 * IAM action list is boilerplate.
 */

/**
 * Build the impl Effect for a Schemas operation scoped to a {@link Schema}:
 * the deploy-time half grants `actions` on the bound schema's ARN, and the
 * runtime half injects the schema's `RegistryName` + `SchemaName` into every
 * request.
 */
export const makeSchemasSchemaHttpBinding = <
  I extends { RegistryName: string; SchemaName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Schemas.DescribeSchema`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the schema ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (schema: Schema) {
      const RegistryName = yield* schema.registryName;
      const SchemaName = yield* schema.schemaName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${schema}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [schema.schemaArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${schema.LogicalId})`)(function* (
        request?: Omit<I, "RegistryName" | "SchemaName">,
      ) {
        return yield* op({
          ...request,
          RegistryName: yield* RegistryName,
          SchemaName: yield* SchemaName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Schemas operation scoped to a {@link Registry}:
 * the deploy-time half grants `actions` on the registry ARN and on the
 * registry's schema-type ARN (`…:schema/{registryName}*` — the resource
 * `schemas:SearchSchemas` authorizes against), and the runtime half injects
 * the registry's `RegistryName` into every request.
 */
export const makeSchemasRegistryHttpBinding = <
  I extends { RegistryName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Schemas.SearchSchemas`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the registry ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (registry: Registry) {
      const RegistryName = yield* registry.registryName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${registry}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  registry.registryArn,
                  // Registry-scoped reads (e.g. SearchSchemas) authorize
                  // against the schema-type ARN keyed by the registry name.
                  Output.map(
                    registry.registryArn,
                    (arn) => `${arn.replace(":registry/", ":schema/")}*`,
                  ),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${registry.LogicalId})`)(function* (
        request?: Omit<I, "RegistryName">,
      ) {
        return yield* op({
          ...request,
          RegistryName: yield* RegistryName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a Schemas operation scoped to a
 * {@link Discoverer}: the deploy-time half grants `actions` on the bound
 * discoverer's ARN (plus `ruleActions` on the discoverer's managed
 * EventBridge rule, which Start/StopDiscoverer flip behind the scenes), and
 * the runtime half injects the `DiscovererId` into every request.
 */
export const makeSchemasDiscovererHttpBinding = <
  I extends { DiscovererId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Schemas.StartDiscoverer`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the discoverer ARN. */
  actions: readonly string[];
  /**
   * EventBridge actions granted on the discoverer's managed rule
   * (`rule/{busName}/Schemas-{discovererId}`). StartDiscoverer enables the
   * rule and StopDiscoverer disables it, so they additionally require
   * `events:EnableRule` / `events:DisableRule`.
   */
  ruleActions?: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (discoverer: Discoverer) {
      const DiscovererId = yield* discoverer.discovererId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // The managed rule is named `Schemas-{discovererId}` but TRUNCATED
          // to EventBridge's 64-char rule-name limit, so the grant wildcards
          // the name under the `Schemas-` prefix instead of interpolating
          // the full discoverer id.
          const toRuleArn = (busSegment: string) =>
            Output.map(
              discoverer.discovererArn,
              (arn) =>
                `${arn.replace(":schemas:", ":events:").split(":discoverer/")[0]}:rule/${busSegment}Schemas-*`,
            );
          yield* host.bind`Allow(${host}, ${options.tag}(${discoverer}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [discoverer.discovererArn],
              },
              ...(options.ruleActions !== undefined
                ? [
                    {
                      Effect: "Allow" as const,
                      Action: [...options.ruleActions],
                      // The managed rule lives on the discovered bus
                      // (`rule/{busName}/Schemas-{id}`) or, for the default
                      // bus, directly under `rule/Schemas-{id}`.
                      Resource: [toRuleArn("*/"), toRuleArn("")],
                    },
                  ]
                : []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${discoverer.LogicalId})`)(function* (
        request?: Omit<I, "DiscovererId">,
      ) {
        return yield* op({
          ...request,
          DiscovererId: yield* DiscovererId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Schemas operation (e.g.
 * `GetDiscoveredSchema`, which infers a schema from sample events and is not
 * scoped to any registry or schema resource). The deploy-time half grants
 * `actions` on `*`.
 */
export const makeSchemasAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Schemas.GetDiscoveredSchema`. */
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
