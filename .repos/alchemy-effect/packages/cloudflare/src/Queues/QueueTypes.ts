import * as Data from "effect/Data";

/** Options accepted by a single {@link WriteQueueClient.send} call. */
export interface SendOptions {
  contentType?: "json" | "text";
}

/** A single message handed to {@link WriteQueueClient.sendBatch}. */
export interface SendMessage {
  body: unknown;
  contentType?: "json" | "text";
}

export class SendError extends Data.TaggedError("SendError")<{
  message: string;
  cause?: unknown;
}> {}
