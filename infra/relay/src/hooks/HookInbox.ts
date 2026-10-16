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

export class HookInbox extends Context.Service<
  HookInbox,
  {
    /** False when the environment's inbox is full and nothing was stored. */
    readonly hold: (input: {
      readonly endpointKey: string;
      readonly baseUrl: string;
      readonly hook: HeldHook;
    }) => Effect.Effect<boolean, HookInboxError>;
    readonly wake: (input: {
      readonly endpointKey: string;
      readonly baseUrl: string;
    }) => Effect.Effect<boolean, HookInboxError>;
    readonly clear: (input: {
      readonly endpointKey: string;
    }) => Effect.Effect<void, HookInboxError>;
  }
>()("t3code-relay/hooks/HookInbox") {}
