import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { resolveBufferedProviderContinuation } from "./bufferedProviderContinuation.ts";

it("drains on the selection the owning session last ran, not one queued and never started", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:owner");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const ran = { instanceId, model: "claude-sonnet-4-6" };
  const continuation = resolveBufferedProviderContinuation(
    {
      providerThreads: [{ id: providerThreadId }],
      runs: [
        { providerThreadId, startedAt: DateTime.makeUnsafe(0), modelSelection: ran },
        {
          providerThreadId,
          startedAt: null,
          modelSelection: { instanceId, model: "claude-opus-4-6" },
        },
      ],
    },
    {
      type: "message.dispatch",
      commandId: CommandId.make("command:wake"),
      threadId: ThreadId.make("thread:owner"),
      messageId: MessageId.make("message:wake"),
      text: "Background activity updated",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "provider",
      continuationProviderThreadId: providerThreadId,
      notification: {
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Background activity updated",
      },
    },
  );
  assert.deepEqual(continuation?.modelSelection, ran);
});
