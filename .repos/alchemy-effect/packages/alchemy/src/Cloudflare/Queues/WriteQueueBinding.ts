import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeQueueBinding, makeQueueHelpers } from "./QueueBinding.ts";
import type { SendMessage, SendOptions } from "./QueueTypes.ts";
import { WriteQueue, type WriteQueueClient } from "./WriteQueue.ts";

/**
 * Implementation of the {@link WriteQueue} service that uses a native Worker
 * queue binding.
 */
export const WriteQueueBinding = Layer.effect(
  WriteQueue,
  Effect.suspend(() => makeQueueBinding({ makeClient: makeWriteQueueClient })),
);

/** Build the producer client over a native Worker queue binding. */
export const makeWriteQueueClient = ({
  raw,
  use,
}: ReturnType<typeof makeQueueHelpers>): WriteQueueClient => ({
  raw,
  send: (body: unknown, options?: SendOptions) =>
    use((q) => q.send(body, options)),
  sendBatch: (messages: ReadonlyArray<SendMessage>) =>
    use((q) =>
      q.sendBatch(
        messages.map((m) => ({
          body: m.body,
          ...(m.contentType ? { contentType: m.contentType } : {}),
        })),
      ),
    ),
});
