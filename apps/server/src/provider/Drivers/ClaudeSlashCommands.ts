import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/**
 * A failed Claude capability probe must not wipe a previously discovered
 * slash-command list (#7111). A successful empty probe is kept as-is so
 * cleared commands leave the `/` menu, and the last-good cache is cleared
 * with them so a later failed probe cannot resurrect deleted commands.
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

export const rememberClaudeSlashCommands = <
  Snapshot extends {
    readonly status: string;
    readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  },
>(
  lastGoodSlashCommands: Ref.Ref<ReadonlyArray<ServerProviderSlashCommand>>,
  snapshot: Snapshot,
): Effect.Effect<Snapshot> =>
  Effect.gen(function* () {
    const previous = yield* Ref.get(lastGoodSlashCommands);
    const slashCommands = retainClaudeSlashCommands(
      snapshot.slashCommands,
      previous,
      snapshot.status !== "ready",
    );
    yield* Ref.set(lastGoodSlashCommands, slashCommands);
    return slashCommands === snapshot.slashCommands ? snapshot : { ...snapshot, slashCommands };
  });
