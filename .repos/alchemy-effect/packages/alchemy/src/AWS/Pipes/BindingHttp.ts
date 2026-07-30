/**
 * Shared scaffolding for EventBridge Pipes HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate:
 *
 * - Pipe-scoped operations (`pipes:DescribePipe`, `pipes:StartPipe`,
 *   `pipes:StopPipe`) inject the bound {@link Pipe}'s name as the request's
 *   `Name` field and are granted on the pipe ARN.
 * - Account-level operations (`pipes:ListPipes`) take the caller's request
 *   as-is and are granted on `*`.
 */
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Pipe } from "./Pipe.ts";

/**
 * Build the impl Effect for a Pipes operation scoped to a {@link Pipe}: the
 * deploy-time half grants `actions` on the bound pipe's ARN, and the runtime
 * half injects the pipe's name as the request's `Name` field.
 */
export const makePipesHttpBinding = <
  I extends { Name: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Pipes.StartPipe`. */
  tag: string;
  /** The distilled operation; `Name` is injected from the pipe. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the pipe ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (pipe: Pipe) {
      const PipeName = yield* pipe.pipeName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${pipe}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [pipe.pipeArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${pipe.LogicalId})`)(function* (
        request?: Omit<I, "Name">,
      ) {
        return yield* op({
          ...request,
          Name: yield* PipeName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Pipes operation (pipe listing).
 * The deploy-time half grants `actions` on `*` — these operations are not
 * scoped to a single pipe resource.
 */
export const makePipesAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Pipes.ListPipes`. */
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
