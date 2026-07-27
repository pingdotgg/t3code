import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { BotAlias } from "./BotAlias.ts";

/**
 * Shared HTTP scaffolding for the Lex V2 runtime bindings.
 *
 * Every Lex V2 conversation capability follows the same shape — resolve the
 * distilled `lex-runtime-v2` operation, register a `lex:*` IAM policy
 * statement on the binding host scoped to the bot alias, and return a
 * runtime callable that injects the alias's `botId` + `botAliasId`. The only
 * variation is the operation and the IAM action, so those are the inputs.
 *
 * @internal — not exported from `index.ts`.
 */

type LexRequirements = Credentials | AwsRegion | HttpClient.HttpClient;

export interface LexAliasHttpBindingConfig<Req extends object, Out, Err> {
  /**
   * Short capability name used in the binding sid and runtime span, e.g.
   * `"RecognizeText"`.
   */
  capability: string;
  /**
   * IAM actions granted to the binding host on the alias ARN, e.g.
   * `["lex:RecognizeText"]`.
   */
  iamActions: readonly string[];
  /**
   * The distilled `lex-runtime-v2` operation implementing the capability.
   */
  operation: Effect.Effect<
    (
      input: Req & { botId: string; botAliasId: string },
    ) => Effect.Effect<Out, Err>,
    never,
    LexRequirements
  >;
}

/**
 * Build the implementation effect for a bot-alias-scoped Lex V2 runtime
 * capability: `Layer.effect(Cap, makeLexAliasHttpBinding({ ... }))`.
 *
 * The runtime callable injects the bound alias's `botId` and `botAliasId`,
 * so `Req` is the operation's request type without those fields.
 */
export const makeLexAliasHttpBinding = <Req extends object, Out, Err>(
  config: LexAliasHttpBindingConfig<Req, Out, Err>,
) =>
  Effect.gen(function* () {
    const op = yield* config.operation;

    return Effect.fn(function* (alias: BotAlias) {
      const BotId = yield* alias.botId;
      const BotAliasId = yield* alias.botAliasId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.LexV2.${config.capability}(${alias}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...config.iamActions],
                  Resource: [alias.botAliasArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.LexV2.${config.capability}(${alias.LogicalId})`)(
        function* (request: Req) {
          return yield* op({
            ...request,
            botId: yield* BotId,
            botAliasId: yield* BotAliasId,
          });
        },
      );
    });
  });
