import type { ServerProviderSlashCommand } from "@t3tools/contracts";

/**
 * A failed Claude capability probe must not wipe a previously discovered
 * slash-command list (#7111). A successful empty probe is kept as-is so
 * cleared commands leave the `/` menu.
 */
export function retainClaudeSlashCommands(
  incoming: ReadonlyArray<ServerProviderSlashCommand>,
  previous: ReadonlyArray<ServerProviderSlashCommand>,
  reusePreviousOnEmpty: boolean,
): ReadonlyArray<ServerProviderSlashCommand> {
  if (incoming.length > 0) {
    return incoming;
  }
  return reusePreviousOnEmpty && previous.length > 0 ? previous : incoming;
}
