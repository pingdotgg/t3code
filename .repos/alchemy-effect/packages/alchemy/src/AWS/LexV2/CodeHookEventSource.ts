import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BotAlias } from "./BotAlias.ts";

/**
 * The intent inside a code hook event's `sessionState` — the intent Lex is
 * currently eliciting or fulfilling.
 */
export interface CodeHookIntent {
  /** Name of the intent. */
  name: string;
  /** Slot values gathered so far (`slotName` → value or `null`). */
  slots?: Record<string, unknown>;
  /** `InProgress` | `ReadyForFulfillment` | `Fulfilled` | `Failed` | ... */
  state?: string;
  /** How the intent was matched (`Confirmed`/`Denied`/`None`). */
  confirmationState?: string;
}

/**
 * The `sessionState` envelope shared by code hook events and responses —
 * the conversation's active intent, dialog action, and session attributes.
 */
export interface CodeHookSessionState {
  /** The active intent and its slots. */
  intent?: CodeHookIntent;
  /** What Lex should do next (`Close`, `ElicitSlot`, `Delegate`, ...). */
  dialogAction?: {
    type: string;
    slotToElicit?: string;
  };
  /** Application-specific session attributes. */
  sessionAttributes?: Record<string, string>;
  /** Contexts active for the current turn. */
  activeContexts?: unknown[];
  /** The locale and other original request metadata. */
  [key: string]: unknown;
}

/**
 * The event Amazon Lex V2 delivers to a dialog or fulfillment Lambda code
 * hook (the `messageVersion: "1.0"` envelope).
 */
export interface CodeHookEvent {
  /** Always `"1.0"`. */
  messageVersion: string;
  /** Which hook fired: `DialogCodeHook` or `FulfillmentCodeHook`. */
  invocationSource: "DialogCodeHook" | "FulfillmentCodeHook";
  /** How the user provided input (`Text`, `Speech`, `DTMF`). */
  inputMode: string;
  /** The bot, alias, and locale the conversation runs against. */
  bot: {
    id: string;
    name: string;
    aliasId: string;
    aliasName?: string;
    localeId: string;
    version: string;
  };
  /** Identifier of the conversation session. */
  sessionId: string;
  /** The user's raw input for this turn. */
  inputTranscript?: string;
  /** The interpretations Lex considered for this turn. */
  interpretations?: unknown[];
  /** Request attributes sent by the client. */
  requestAttributes?: Record<string, string>;
  /** The conversation state at the time of invocation. */
  sessionState: CodeHookSessionState;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/**
 * The response a code hook returns to Amazon Lex V2 — the (usually mutated)
 * `sessionState` plus optional messages to relay to the user.
 */
export interface CodeHookResponse {
  /** The new conversation state (dialog action, intent state, slots). */
  sessionState: CodeHookSessionState;
  /** Messages to relay to the user. */
  messages?: {
    contentType: "PlainText" | "SSML" | "CustomPayload" | "ImageResponseCard";
    content?: string;
  }[];
  /** Request attributes to echo back. */
  requestAttributes?: Record<string, string>;
}

export interface CodeHookProps {
  /**
   * The alias locale whose code hook this function handles, e.g. `en_US`.
   * The alias's `botAliasLocaleSettings` for this locale are pointed at the
   * hosting Lambda.
   */
  localeId: string;
}

/**
 * A code hook handler receives the typed Lex event and returns the full
 * response Lex expects (`sessionState` + optional `messages`). Use
 * {@link fulfillIntent} to build a valid close response.
 */
export type CodeHookHandler<Req = never> = (
  event: CodeHookEvent,
) => Effect.Effect<CodeHookResponse, never, Req>;

export type CodeHookEventSourceService = <Req = never>(
  alias: BotAlias,
  props: CodeHookProps,
  handler: CodeHookHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting an Amazon Lex V2 bot alias's Lambda code hook
 * (dialog and fulfillment) to the hosting Lambda function.
 *
 * At deploy time the implementation (`LexV2.LambdaCodeHookEventSource`)
 * injects the function ARN into the alias's `botAliasLocaleSettings`
 * (through the alias's binding contract) and creates the
 * `lambda:InvokeFunction` Permission for `lexv2.amazonaws.com`; at runtime
 * it dispatches matching code hook events to the handler and returns the
 * handler's response to Lex.
 *
 * Enable the hook per intent with the `dialogCodeHook` /
 * `fulfillmentCodeHook` props on `LexV2.Intent`.
 *
 * Use the {@link onCodeHook} helper rather than the service directly, and
 * provide `LexV2.LambdaCodeHookEventSource` on the hosting function.
 * @binding
 * @section Handling Code Hooks
 * @example Fulfill an Intent from a Lambda Function
 * ```typescript
 * export default BotFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const alias = yield* AWS.LexV2.BotAlias("Live", {
 *       botId: version.botId,
 *       botVersion: version.botVersion,
 *     });
 *
 *     // deploy: wires the alias's en_US code hook + invoke Permission
 *     // runtime: dispatches code hook events to this handler
 *     yield* AWS.LexV2.onCodeHook(alias, { localeId: "en_US" }, (event) =>
 *       Effect.succeed(
 *         AWS.LexV2.fulfillIntent(event, { message: "Order placed!" }),
 *       ),
 *     );
 *
 *     return {};
 *   }).pipe(Effect.provide(AWS.LexV2.LambdaCodeHookEventSource)),
 * );
 * ```
 */
export interface CodeHookEventSource extends Binding.Service<
  CodeHookEventSource,
  "AWS.LexV2.CodeHookEventSource",
  CodeHookEventSourceService
> {}

export const CodeHookEventSource = Binding.Service<CodeHookEventSource>(
  "AWS.LexV2.CodeHookEventSource",
);

/**
 * Handle an Amazon Lex V2 code hook (dialog + fulfillment) for a bot alias
 * locale with the current Lambda function.
 *
 * Provide `LexV2.LambdaCodeHookEventSource` on the hosting function to
 * satisfy the requirement.
 *
 * @param alias The bot alias whose code hook to handle.
 * @param props The alias locale to attach to.
 * @param handler Invoked once per code hook event; the returned value is
 * the response Lex receives.
 *
 * @example Close every fulfilled intent with a message
 * ```typescript
 * yield* LexV2.onCodeHook(alias, { localeId: "en_US" }, (event) =>
 *   Effect.succeed(LexV2.fulfillIntent(event, { message: "Done!" })),
 * );
 * ```
 */
export function onCodeHook<Req = never>(
  alias: BotAlias,
  props: CodeHookProps,
  handler: CodeHookHandler<Req>,
): Effect.Effect<void, never, CodeHookEventSource> {
  return CodeHookEventSource.use((source) => source(alias, props, handler));
}

/**
 * Build a valid code hook response that closes the event's active intent as
 * `Fulfilled` (or `Failed`), optionally relaying a plain-text message —
 * the common shape for a fulfillment code hook.
 *
 * @example Fulfillment hook that confirms the order
 * ```typescript
 * yield* LexV2.onCodeHook(alias, { localeId: "en_US" }, (event) =>
 *   Effect.succeed(
 *     LexV2.fulfillIntent(event, { message: "Your order is placed." }),
 *   ),
 * );
 * ```
 */
export const fulfillIntent = (
  event: CodeHookEvent,
  options?: {
    /** Plain-text message to relay to the user. */
    message?: string;
    /** The intent's final state. @default "Fulfilled" */
    state?: "Fulfilled" | "Failed";
  },
): CodeHookResponse => ({
  sessionState: {
    ...event.sessionState,
    dialogAction: { type: "Close" },
    intent: {
      ...event.sessionState.intent!,
      state: options?.state ?? "Fulfilled",
    },
  },
  ...(options?.message !== undefined
    ? {
        messages: [
          { contentType: "PlainText" as const, content: options.message },
        ],
      }
    : {}),
});
