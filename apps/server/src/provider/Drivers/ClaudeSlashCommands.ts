import type { ServerProviderSlashCommand } from "@t3tools/contracts";

/**
 * A failed or empty Claude capability probe must not wipe a previously
 * discovered slash-command list (#7111).
 */
export function retainClaudeSlashCommands(
  incoming: ReadonlyArray<ServerProviderSlashCommand>,
  previous: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  if (incoming.length > 0) {
    return incoming;
  }
  return previous.length > 0 ? previous : incoming;
}
