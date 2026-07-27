import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared scaffolding for AWS Translate HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action list is
 * boilerplate. The bindings take terminology/parallel-data/job identifiers
 * at runtime (not as bound resources), so grants are on `Resource: ["*"]`.
 */

/**
 * Build the impl Effect for a Translate operation with no bound resource
 * (real-time translation, terminology/parallel-data reads, job
 * describe/list/stop).
 */
export const makeTranslateHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Translate.TranslateText`. */
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
 * Build the impl Effect for `StartTextTranslationJob`: the binding is
 * constructed with the **data-access role** (the IAM role Amazon Translate
 * assumes to read input documents from S3 and write results; its trust
 * policy must allow `translate.amazonaws.com`). The role's ARN is injected
 * as `DataAccessRoleArn` on every runtime request, and the deploy-time half
 * grants `actions` on `*` plus `iam:PassRole` on the role — without the
 * PassRole grant, the start call fails only at runtime with an AccessDenied.
 * `ClientToken` is optional on the runtime request (the AWS SDK also
 * auto-generates it) — a UUID is generated per call when omitted.
 */
export const makeTranslateStartJobHttpBinding = <
  I extends { DataAccessRoleArn: string; ClientToken: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Translate.StartTextTranslationJob`. */
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
              // CRITICAL: without iam:PassRole on the data-access role, the
              // start call fails only at runtime with an AccessDenied.
              {
                Effect: "Allow",
                Action: ["iam:PassRole"],
                Resource: [Output.interpolate`${dataAccessRole.roleArn}`],
                Condition: {
                  StringEquals: {
                    "iam:PassedToService": "translate.amazonaws.com",
                  },
                },
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${dataAccessRole.LogicalId})`)(
        function* (
          request: Omit<I, "DataAccessRoleArn" | "ClientToken"> & {
            DataAccessRoleArn?: string;
            ClientToken?: string;
          },
        ) {
          return yield* op({
            ...request,
            DataAccessRoleArn: request.DataAccessRoleArn ?? (yield* RoleArn),
            ClientToken:
              request.ClientToken ??
              (yield* Effect.sync(() => crypto.randomUUID())),
          } as I);
        },
      );
    });
  });
