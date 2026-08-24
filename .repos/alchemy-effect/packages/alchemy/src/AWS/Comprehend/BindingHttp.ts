import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared scaffolding for AWS Comprehend HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action list is
 * boilerplate: Comprehend's real-time detect APIs and async job APIs have no
 * resource-level IAM, so every grant is on `*`. The `Start*Job` operations
 * additionally inject the bound data-access role and a scoped `iam:PassRole`
 * grant.
 */

/**
 * Build the impl Effect for a Comprehend operation with no bound resource
 * (real-time detection, job describe/list/stop). The deploy-time half grants
 * `actions` on `*` — Comprehend detection and job IAM actions do not support
 * resource-level scoping.
 */
export const makeComprehendHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Comprehend.DetectEntities`. */
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

/**
 * Build the impl Effect for a `Start*Job` operation: the binding is
 * constructed with the **data-access role** (the IAM role Amazon Comprehend
 * assumes to read input documents from S3 and write results; its trust
 * policy must allow `comprehend.amazonaws.com`). The role's ARN is injected
 * as `DataAccessRoleArn` on every runtime request, and the deploy-time half
 * grants `actions` on `*` plus `iam:PassRole` on the role — without the
 * PassRole grant, `Start*Job` fails only at runtime with an AccessDenied.
 */
export const makeComprehendStartJobHttpBinding = <
  I extends { DataAccessRoleArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Comprehend.StartSentimentDetectionJob`. */
  tag: string;
  /** The distilled operation; `DataAccessRoleArn` is injected from the role. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <Rl extends Role>(dataAccessRole: Rl) {
      const RoleArn = yield* dataAccessRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${dataAccessRole}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
              // CRITICAL: without iam:PassRole on the data-access role,
              // Start*Job fails only at runtime with an AccessDenied.
              {
                Effect: "Allow",
                Action: ["iam:PassRole"],
                Resource: [Output.interpolate`${dataAccessRole.roleArn}`],
                Condition: {
                  StringEquals: {
                    "iam:PassedToService": "comprehend.amazonaws.com",
                  },
                },
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${dataAccessRole.LogicalId})`)(
        function* (
          request: Omit<I, "DataAccessRoleArn"> & {
            DataAccessRoleArn?: string;
          },
        ) {
          return yield* op({
            ...request,
            DataAccessRoleArn: request.DataAccessRoleArn ?? (yield* RoleArn),
          } as I);
        },
      );
    });
  });
