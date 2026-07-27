import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Graph } from "./Graph.ts";

/**
 * Shared scaffolding for Amazon Detective HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for a Detective operation scoped to a behavior
 * {@link Graph}: the deploy-time half grants `actions` on the bound graph's
 * ARN, and the runtime half injects the graph's `GraphArn` into every
 * request.
 */
export const makeDetectiveGraphHttpBinding = <
  I extends { GraphArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Detective.ListMembers`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the behavior graph ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (graph: Graph) {
      const GraphArn = yield* graph.graphArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${graph}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [graph.graphArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${graph.LogicalId})`)(function* (
        request?: Omit<I, "GraphArn">,
      ) {
        const graphArn = yield* GraphArn;
        return yield* op({ ...request, GraphArn: graphArn } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level Detective operation — the
 * member-account invitation flow (`AcceptInvitation`, `RejectInvitation`,
 * `DisassociateMembership`, `ListInvitations`,
 * `BatchGetMembershipDatasources`) and the organization-admin actions. The
 * deploy-time half grants `actions` on `*`: these operations either take no
 * resource at all or target a behavior graph owned by a *different* (admin)
 * account whose ARN is only known at runtime.
 */
export const makeDetectiveAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Detective.ListInvitations`. */
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
