import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { BrowserCustom } from "./BrowserCustom.ts";
import type { CodeInterpreter } from "./CodeInterpreter.ts";
import type { Memory } from "./Memory.ts";
import type { Runtime } from "./Runtime.ts";

/**
 * Shared scaffolding for Bedrock AgentCore data-plane HTTP bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, makeAgentCoreHttpBinding({ … }))` over
 * the builder below. Everything except the operation, the IAM action list,
 * the injected identifier, and the granted ARNs is boilerplate: the runtime
 * callable injects the bound resource's identifier (memory id, code
 * interpreter id, browser id, or agent runtime ARN) as `requestKey`, and the
 * deploy-time half grants `actions` on `arns`.
 *
 * Genuinely-different bindings (custom request shaping like the
 * `sessionTimeout` duration conversion in `StartCodeInterpreterSession` /
 * `StartBrowserSession`) stay bespoke.
 */

/** The AgentCore resources data-plane bindings can scope to. */
export type AgentCoreBindable =
  | Memory
  | CodeInterpreter
  | BrowserCustom
  | Runtime;

/**
 * Build the impl Effect for a single-operation AgentCore data-plane binding.
 * The runtime callable injects the resolved `identifier` as the request's
 * `requestKey` field; the deploy-time half grants `actions` on `arns`.
 */
export const makeAgentCoreHttpBinding = <
  Res extends AgentCoreBindable,
  I extends object,
  K extends keyof I & string,
  A,
  E,
  R,
  IdReq = never,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.BedrockAgentCore.GetEvent`. */
  tag: string;
  /** The distilled operation; `requestKey` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `arns`. */
  actions: readonly string[];
  /** The request field the resolved identifier is injected as. */
  requestKey: K;
  /** Resolve the injected identifier from the bound resource. */
  identifier: (resource: Res) => Output.Output<string, IdReq>;
  /** IAM resource ARNs granted `actions`. */
  arns: (resource: Res) => readonly Output.Output<string>[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (resource: Res) {
      const Identifier = yield* options.identifier(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${resource}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [...options.arns(resource)],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        return yield* op({
          ...request,
          [options.requestKey]: yield* Identifier,
        } as I);
      });
    });
  });
