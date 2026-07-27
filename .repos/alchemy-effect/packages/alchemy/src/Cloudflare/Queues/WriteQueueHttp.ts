import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { authorizeWith } from "../HttpClientUtils.ts";
import {
  makeHttpQueueBinding,
  makeQueueHttpScope,
  toQueueSendError,
  type QueueAuth,
} from "./QueueHttp.ts";
import { SendError, type SendMessage } from "./QueueTypes.ts";
import { WriteQueue, type WriteQueueClient } from "./WriteQueue.ts";

/**
 * HTTP-backed implementation of the {@link WriteQueue} service.
 *
 * It creates a scoped {@link AccountApiToken} with the `Queues Write`
 * permission and pushes messages via the Cloudflare Queues bulk-push
 * HTTP API (`POST /messages/batch`). The bulk endpoint takes the raw
 * JSON value as the message `body` (the single-message endpoint
 * expects a pre-encoded string), so it round-trips arbitrary
 * JSON-serializable payloads the same way the native producer binding
 * does — `send` is just a batch of one.
 */
export const WriteQueueHttp = Layer.effect(
  WriteQueue,
  Effect.suspend(() =>
    makeHttpQueueBinding({
      permissionGroups: ["Queues Write"],
      makeClient: (token, queueId) =>
        makeWriteQueueHttpClient(
          { authorize: authorizeWith(token), accountId: token.accountId },
          queueId,
        ),
    }),
  ),
);

/** Convert a message into the Cloudflare bulk-push `messages[]` shape. */
const toMessage = (message: SendMessage) =>
  message.contentType === "text"
    ? {
        body:
          typeof message.body === "string"
            ? message.body
            : String(message.body),
        contentType: "text" as const,
      }
    : { body: message.body, contentType: "json" as const };

/**
 * Build the producer client over the Queues bulk-push HTTP API.
 *
 * Shared by {@link WriteQueueHttp} (scoped token auth) and
 * `WriteQueueLocal` (current-credentials auth) — they differ only in the
 * {@link QueueAuth} they inject.
 */
export const makeWriteQueueHttpClient = (
  auth: QueueAuth,
  queueId: Effect.Effect<string>,
): WriteQueueClient => {
  const scope = makeQueueHttpScope(auth, queueId);

  const push = (messages: ReadonlyArray<SendMessage>) =>
    scope.pipe(
      Effect.flatMap(({ accountId, queueId }) =>
        auth.authorize(
          queues.bulkPushMessages({
            accountId,
            queueId,
            messages: messages.map(toMessage),
          }),
        ),
      ),
      Effect.mapError(toQueueSendError),
      Effect.asVoid,
    );

  return {
    raw: Effect.die(
      new SendError({
        message:
          "Queue HTTP client does not expose a native Queue binding; use send/sendBatch.",
        cause: new Error("unsupported"),
      }),
    ),
    send: (body: unknown, options?: { contentType?: "json" | "text" }) =>
      push([{ body, contentType: options?.contentType }]),
    sendBatch: (messages: ReadonlyArray<SendMessage>) => push(messages),
  };
};
