/**
 * Hidden CLI entry points for the Antigravity ACP bridge.
 *
 * Both are internal plumbing rather than user-facing commands: the provider
 * spawns `t3 agy-acp` as an ACP agent, and that bridge registers `t3 agy-hook
 * <event>` as Antigravity's tool-lifecycle hook. Shipping them as subcommands
 * of the server binary keeps the bridge inside the same bundle.
 *
 * @module cli/agy
 */
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { runAgyBridge, runAgyHook } from "../provider/acp/antigravity/agyBridge.ts";

export const agyAcpCommand = Command.make("agy-acp").pipe(
  Command.withDescription("Run the Antigravity ACP compatibility bridge over stdio."),
  Command.withHidden,
  Command.withHandler(() => Effect.promise(() => runAgyBridge())),
);

export const agyHookCommand = Command.make("agy-hook", {
  event: Flag.string("event").pipe(
    Flag.withDescription("Antigravity hook event name."),
    Flag.withDefault("unknown"),
  ),
}).pipe(
  Command.withDescription("Handle one Antigravity tool-lifecycle hook event."),
  Command.withHidden,
  Command.withHandler(({ event }) => Effect.promise(() => runAgyHook(event))),
);
