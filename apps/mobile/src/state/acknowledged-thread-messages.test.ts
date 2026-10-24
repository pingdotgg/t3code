import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { unsettledAcknowledgedThreadMessages } from "./acknowledged-thread-messages";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

function acknowledged(messageId: string, acknowledgedSequence?: number) {
  return {
    environmentId,
    threadId,
    messageId: MessageId.make(messageId),
    commandId: CommandId.make(`command-${messageId}`),
    text: messageId,
    attachments: [],
    // Client time can be ahead of the server, or equal for different sends.
    createdAt: "2099-01-01T00:00:00.000Z",
    ...(acknowledgedSequence === undefined ? {} : { acknowledgedSequence }),
  };
}

describe("acknowledged message reconciliation", () => {
  it("settles an unloaded echo only after a bounded snapshot includes its receipt", () => {
    const old = acknowledged("accepted-outside-window", 40);
    const inFlight = acknowledged("accepted-after-snapshot", 51);
    const unknown = acknowledged("no-ordering-evidence");
    const otherThread = { ...old, threadId: ThreadId.make("thread-2") };
    const otherEnvironment = { ...old, environmentId: EnvironmentId.make("environment-2") };
    const echoed = acknowledged("loaded-echo", 52);
    const messages = [old, inFlight, unknown, otherThread, otherEnvironment, echoed];
    const echoes = new Set([echoed.messageId]);
    const history = { environmentId, threadId, hasMoreHistory: true, snapshotSequence: 40 };

    expect(unsettledAcknowledgedThreadMessages(messages, echoes, history)).toEqual([
      inFlight,
      unknown,
      otherThread,
      otherEnvironment,
    ]);
    expect(
      unsettledAcknowledgedThreadMessages(messages, echoes, { ...history, snapshotSequence: 39 }),
    ).toEqual([old, inFlight, unknown, otherThread, otherEnvironment]);
  });

  it("keeps missing echoes without evidence of a bounded, committed history window", () => {
    const message = acknowledged("still-waiting", 40);
    const history = { environmentId, threadId, hasMoreHistory: false, snapshotSequence: 50 };
    expect(unsettledAcknowledgedThreadMessages([message], new Set(), history)).toEqual([message]);
    expect(
      unsettledAcknowledgedThreadMessages([message], new Set(), {
        environmentId,
        threadId,
        hasMoreHistory: true,
      }),
    ).toEqual([message]);
  });
});
