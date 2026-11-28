import { useAtomValue } from "@effect/atom-react";
import type { BotAvatarChoice, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { scopedThreadKey } from "../../lib/scopedEntities";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { environmentThreadShells } from "../../state/threads";

/** A Bot as a chat shows it: its name and avatar. */
export interface BotIdentity {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly avatar: BotAvatarChoice | null;
}

const NO_BOT_SENDERS: ReadonlyMap<string, BotIdentity> = new Map();

// Keyed by the senders' thread refs, so a feed subscribes only to the shells of who wrote to it.
const botSendersAtom = Atom.family((key: string) => {
  const refs = JSON.parse(key) as ReadonlyArray<[EnvironmentId, ThreadId]>;
  let previous = NO_BOT_SENDERS;
  return Atom.make((get) => {
    const next = new Map<string, BotIdentity>();
    for (const [environmentId, threadId] of refs) {
      const shell = get(environmentThreadShells.quietThreadShellAtom({ environmentId, threadId }));
      if (shell?.botConfig == null) continue;
      next.set(scopedThreadKey(environmentId, threadId), {
        threadId: shell.id,
        name: shell.title,
        avatar: shell.botConfig.avatar ?? null,
      });
    }
    const unchanged =
      next.size === previous.size &&
      [...next].every(([senderKey, bot]) => {
        const old = previous.get(senderKey);
        return (
          old?.name === bot.name &&
          old.avatar?.shape === bot.avatar?.shape &&
          old.avatar?.color === bot.avatar?.color
        );
      });
    if (!unchanged) previous = next.size === 0 ? NO_BOT_SENDERS : next;
    return previous;
  });
});

/**
 * The Bots among the agents whose messages are in the feed, by scoped thread key. Another Bot's
 * message shows in full under its name and avatar instead of the folded agent line.
 */
export function useBotSenders(
  environmentId: EnvironmentId,
  feed: ReadonlyArray<ThreadFeedEntry>,
): ReadonlyMap<string, BotIdentity> {
  const refs = new Map<string, [EnvironmentId, ThreadId]>();
  for (const entry of feed) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const { linkedSender, senderThreadId } = entry.message;
    const ref: [EnvironmentId, ThreadId] | null = linkedSender
      ? [linkedSender.environmentId, linkedSender.threadId]
      : senderThreadId
        ? [environmentId, senderThreadId]
        : null;
    if (ref !== null) refs.set(scopedThreadKey(...ref), ref);
  }
  return useAtomValue(botSendersAtom(JSON.stringify([...refs.values()])));
}
