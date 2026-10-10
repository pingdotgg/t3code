import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

import {
  codexManagedTokenCommandName,
  runCodexManagedTokenCommand,
} from "../provider/codexManagedTokenCommand.ts";

/**
 * `t3 codex-managed-token` — internal credential command managed Codex runs to
 * renew its bearer from the provider's loopback bridge.
 *
 * Real invocations dispatch through the bin.ts fast path before the CLI graph
 * loads; this definition keeps the command wired for anything that drives the
 * full CLI programmatically.
 */
export const codexManagedTokenCommand = Command.make(codexManagedTokenCommandName).pipe(
  Command.withDescription("Print the current managed Codex credential for Codex."),
  Command.unlisted,
  Command.withHandler(() => Effect.promise(() => runCodexManagedTokenCommand())),
);
