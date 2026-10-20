import { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { observeTurn } from "./useNextPromptSuggestion";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const user = { id: MessageId.make("u2"), role: "user" as const, streaming: false };
const earlierReply = { id: MessageId.make("a1"), role: "assistant" as const, streaming: false };
const reply = { id: MessageId.make("a2"), role: "assistant" as const, streaming: false };
const streaming = { ...reply, streaming: true };

const watchTurn = (thread = threadA) => {
  const opened = observeTurn(null, thread, true, earlierReply);
  const running = observeTurn(opened, thread, false, user);
  const replying = observeTurn(running, thread, true, streaming);
  return observeTurn(replying, thread, true, reply);
};

describe("observeTurn", () => {
  it("qualifies the reply that settles at the end of a watched turn", () => {
    const settled = watchTurn();
    expect(settled.settledReplyId).toBe(reply.id);
    expect(observeTurn(settled, threadA, true, reply)).toBe(settled);
  });

  it("never qualifies the reply already showing when a thread is opened", () => {
    expect(observeTurn(null, threadA, true, earlierReply).settledReplyId).toBeNull();
  });

  it("does not move qualification to a reply exposed by a rollback", () => {
    const settled = watchTurn();
    const rolledBack = observeTurn(settled, threadA, true, earlierReply);
    expect(rolledBack.settledReplyId).toBe(reply.id);
  });

  it("qualifies nothing when a turn ends without an agent reply", () => {
    const running = observeTurn(
      observeTurn(null, threadA, true, earlierReply),
      threadA,
      false,
      user,
    );
    expect(observeTurn(running, threadA, true, user).settledReplyId).toBeNull();
  });

  it("forgets the turn on any thread switch, so a background finish never qualifies", () => {
    const settled = watchTurn();
    const otherThread = observeTurn(settled, threadB, true, earlierReply);
    expect(observeTurn(otherThread, threadA, true, reply).settledReplyId).toBeNull();
  });
});
