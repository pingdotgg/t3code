import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { HeldHook } from "./HookInboxStore.ts";

export class HookInboxError extends Schema.TaggedError<HookInboxError>()("HookInboxError", {
  operation: Schema.Literals(["hold", "wake", "clear"]),
  endpointKey: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Hook inbox '${this.operation}' failed for endpoint '${this.endpointKey}'`;
  }
}

/**
 * Webhook requests held for environments that opted in, while they are
 * offline. Each managed endpoint's requests live in its own `HookInboxObject`,
 * named by endpoint key, which delivers them itself once the environment is back.
 */
export class HookInbox extends Context.Service<
  HookInbox,
  {
    /** False when the environment's inbox is full and nothing was stored. */
    readonly hold: (input: {
      readonly endpointKey: string;
      readonly baseUrl: string;
      readonly hook: HeldHook;
    }) => Effect.Effect<boolean, HookInboxError>;
    /** Delivers what is waiting now; true when anything was waiting. */
    readonly wake: (input: {
      readonly endpointKey: string;
      readonly baseUrl: string;
    }) => Effect.Effect<boolean, HookInboxError>;
    readonly clear: (input: {
      readonly endpointKey: string;
    }) => Effect.Effect<void, HookInboxError>;
  }
>()("t3code-relay/hooks/HookInbox") {}
