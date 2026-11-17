import * as DateTime from "effect/DateTime";
import {
  groupAfterDelivered,
  groupAfterMessage,
  groupAfterWave,
  resolveGroupAudience,
} from "../../apps/server/src/orchestration-v2/ThreadGroupDecider.ts";
import {
  renderPrimaryGroupNote,
  renderSeatFirstPrompt,
  renderSeatTurnPrompt,
} from "../../apps/server/src/orchestration-v2/GroupPrompt.ts";
import type { GroupMember } from "../../apps/server/src/orchestration-v2/GroupConversation.ts";
import type { Exchange } from "./cases.ts";
import type { Message } from "./client.ts";
import {
  delta,
  digest,
  group,
  groupEntry,
  peer,
  peerId,
  policy,
  primary,
  wake,
} from "./prompts.ts";

export async function simulateDiscussion(
  request: string,
  parallel: boolean,
  reply: (member: GroupMember, messages: ReadonlyArray<Message>) => Promise<Message>,
) {
  const { planWave } = await policy(parallel);
  const audience = resolveGroupAudience(group(), "everyone");
  let state = groupAfterMessage(group(), audience, "user", 1);
  const entries: Exchange[] = [{ label: "User", text: request }];
  const histories = new Map<GroupMember, Message[]>([
    ["primary", []],
    [peerId, []],
  ]);
  const cursors = new Map<GroupMember, number>([
    ["primary", 0],
    [peerId, 0],
  ]);
  const trace: Array<{ start: ReadonlyArray<GroupMember>; through: number; turnsLeft: number }> =
    [];
  let next: ReadonlyArray<GroupMember> = [
    ...(audience.includesPrimary ? (["primary"] as const) : []),
    ...audience.seats,
  ];
  for (let wave = 0; wave < 4; wave++) {
    const through = entries.length;
    trace.push({ start: next, through, turnsLeft: state.discussion!.turnsLeft });
    const results = await Promise.allSettled(
      next.map(async (member) => {
        const history = histories.get(member)!;
        const unseen = entries
          .slice(cursors.get(member))
          .filter((entry) => entry.label !== (member === "primary" ? "Rowan" : "Kai"));
        const prompt =
          member === "primary"
            ? history.length === 0
              ? [
                  renderPrimaryGroupNote({
                    self: primary,
                    others: [peer],
                    everyoneAddressed: true,
                  }),
                  request,
                ].join("\n\n")
              : wake(unseen)
            : history.length === 0
              ? [
                  digest([]),
                  renderSeatFirstPrompt({
                    self: peer,
                    others: [primary],
                    delta: delta(unseen),
                    reaction: wave > 0,
                  }),
                ].join("\n\n")
              : renderSeatTurnPrompt({ delta: delta(unseen), reaction: true });
        history.push({ role: "user", text: prompt });
        const answer = await reply(member, history);
        if (answer.calls?.length || !answer.text.trim())
          throw new Error("Discussion did not yield a final text reply.");
        history.push(answer);
        cursors.set(member, through);
        return {
          label: member === "primary" ? ("Rowan" as const) : ("Kai" as const),
          text: answer.text,
        };
      }),
    );
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length) throw new Error(errors.map((result) => String(result.reason)).join("\n"));
    entries.push(
      ...results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    );
    for (const member of next) state = groupAfterDelivered(state, member);
    const planned = planWave(
      state,
      (member) =>
        entries
          .map((entry, index) => groupEntry(entry, index + 1))
          .filter((entry) => entry.ordinal > cursors.get(member)! && entry.speaker !== member),
      [],
    );
    if (!planned.start.length)
      return { entries, trace, close: planned.close ?? "settled", histories: [...histories] };
    next = planned.start;
    state = groupAfterWave(state, planned, DateTime.makeUnsafe(0));
  }
  throw new Error("Discussion exceeded the production invocation budget.");
}
