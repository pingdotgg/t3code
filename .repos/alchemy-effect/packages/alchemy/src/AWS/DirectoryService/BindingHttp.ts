import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Directory } from "./Directory.ts";

/**
 * Shared scaffolding for AWS Directory Service HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for an account-level Directory Service operation
 * (enumerating directories, reading account limits). The deploy-time half
 * grants `actions` on `*` — these actions do not support resource-level
 * permissions.
 */
export const makeDirectoryServiceAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DirectoryService.GetDirectoryLimits`. */
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
 * Build the impl Effect for a Directory Service operation scoped to one
 * {@link Directory}: the deploy-time half grants `actions` on the bound
 * directory's ARN (`arn:aws:ds:{region}:{account}:directory/{id}`), and the
 * runtime half injects the directory's `DirectoryId` into every request.
 */
export const makeDirectoryHttpBinding = <
  I extends { DirectoryId?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DirectoryService.CreateSnapshot`. */
  tag: string;
  /** The distilled operation; `DirectoryId` is injected from the directory. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the directory ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (directory: Directory) {
      const DirectoryId = yield* directory.directoryId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          yield* host.bind`Allow(${host}, ${options.tag}(${directory}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`arn:aws:ds:${region}:${accountId}:directory/${directory.directoryId}`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${directory.LogicalId})`)(function* (
        request?: Omit<I, "DirectoryId">,
      ) {
        return yield* op({
          ...request,
          DirectoryId: yield* DirectoryId,
        } as I);
      });
    });
  });
