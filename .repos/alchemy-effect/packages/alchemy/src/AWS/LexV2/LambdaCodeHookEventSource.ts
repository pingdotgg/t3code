import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Namespace from "../../Namespace.ts";
import * as Lambda from "../Lambda/Function.ts";
import { Permission as LambdaPermission } from "../Lambda/Permission.ts";
import type { BotAlias } from "./BotAlias.ts";
import {
  CodeHookEventSource,
  type CodeHookEvent,
  type CodeHookEventSourceService,
  type CodeHookHandler,
  type CodeHookProps,
} from "./CodeHookEventSource.ts";

/**
 * An Amazon Lex V2 code hook invocation — the
 * `messageVersion`/`invocationSource`/`bot`/`sessionState` envelope Lex
 * sends to dialog and fulfillment Lambda functions.
 */
export const isCodeHookEvent = (event: any): event is CodeHookEvent =>
  typeof event?.messageVersion === "string" &&
  (event?.invocationSource === "DialogCodeHook" ||
    event?.invocationSource === "FulfillmentCodeHook") &&
  typeof event?.bot === "object" &&
  event?.bot !== null &&
  typeof event?.bot?.id === "string" &&
  typeof event?.bot?.aliasId === "string" &&
  typeof event?.sessionState === "object" &&
  event?.sessionState !== null;

/**
 * Connects an Amazon Lex V2 bot alias's Lambda code hook to the current
 * Lambda function.
 *
 * At deploy time this layer injects the function ARN into the alias's
 * `botAliasLocaleSettings` through the alias's binding contract and
 * materializes the `lambda:InvokeFunction` Permission for
 * `lexv2.amazonaws.com`; at runtime it dispatches matching code hook events
 * (matched on the bot id, alias id, and locale) to the registered handler
 * and returns the handler's response to Lex.
 * @binding
 * @section Handling Code Hooks
 * @example Fulfill an intent
 * ```typescript
 * yield* LexV2.onCodeHook(alias, { localeId: "en_US" }, (event) =>
 *   Effect.succeed(LexV2.fulfillIntent(event, { message: "Done!" })),
 * );
 * ```
 */
export const LambdaCodeHookEventSource = Layer.effect(
  CodeHookEventSource,
  Effect.gen(function* () {
    // this layer can only be used in a Lambda Function
    const host = yield* Lambda.Function;

    return Effect.fn(function* <Req = never>(
      alias: BotAlias,
      props: CodeHookProps,
      handler: CodeHookHandler<Req>,
    ) {
      const BotId = yield* alias.botId;
      const BotAliasId = yield* alias.botAliasId;

      // Deploy-time: inject this function's ARN into the alias's locale
      // settings (the alias's provider syncs it) and create the invoke
      // Permission for lexv2. Skipped once running inside the deployed
      // Function (the global guard), where the only work is registering
      // the runtime dispatcher below. Namespaced under the host for stable
      // logical identity.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* alias.bind`AWS.LexV2.CodeHook(${host}, ${alias}, ${props.localeId})`(
              {
                codeHooks: { [props.localeId]: host.functionArn },
              },
            );

            yield* LambdaPermission(
              `${alias.LogicalId}-${props.localeId}-CodeHookPermission`,
              {
                action: "lambda:InvokeFunction",
                functionName: host.functionName,
                principal: "lexv2.amazonaws.com",
                sourceArn: alias.botAliasArn,
              },
            );
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          const botId = yield* BotId;
          const botAliasId = yield* BotAliasId;

          return (event: any) => {
            if (
              isCodeHookEvent(event) &&
              event.bot.id === botId &&
              event.bot.aliasId === botAliasId &&
              event.bot.localeId === props.localeId
            ) {
              // Code hooks are request-response: the Lambda's return value
              // (sessionState + messages) IS the hook response.
              return handler(event).pipe(Effect.orDie);
            }
          };
        }),
      );
    }) as CodeHookEventSourceService;
  }),
);
