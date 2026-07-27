import * as sqs from "@distilled.cloud/aws/sqs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface SendMessageRequest extends Omit<
  sqs.SendMessageRequest,
  "QueueUrl"
> {}

/**
 * Runtime binding for `sqs:SendMessage`.
 *
 * Bind this operation to a {@link Queue} inside a function runtime to get a
 * callable that automatically injects the `QueueUrl`. The binding grants the
 * host function `sqs:SendMessage` on the queue. Provide the `SendMessageHttp`
 * layer on the Function to implement the binding.
 * @binding
 * @section Sending Messages
 * @example Send a Message from a Lambda Function
 * ```typescript
 * export class ApiFunction extends Lambda.Function<Lambda.Function>()(
 *   "ApiFunction",
 * ) {}
 *
 * export default ApiFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const queue = yield* SQS.Queue("Jobs");
 *
 *     // init: bind the operation to the queue (grants sqs:SendMessage)
 *     const sendMessage = yield* SQS.SendMessage(queue);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: QueueUrl is injected automatically
 *         const result = yield* sendMessage({ MessageBody: "hello" });
 *         return yield* HttpServerResponse.json({
 *           messageId: result.MessageId,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(SQS.SendMessageHttp)),
 * );
 * ```
 *
 * @example Delay Delivery
 * ```typescript
 * yield* sendMessage({ MessageBody: "process later", DelaySeconds: 60 });
 * ```
 */
export interface SendMessage extends Binding.Service<
  SendMessage,
  "AWS.SQS.SendMessage",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: SendMessageRequest,
    ) => Effect.Effect<sqs.SendMessageResult, sqs.SendMessageError>
  >
> {}

export const SendMessage = Binding.Service<SendMessage>("AWS.SQS.SendMessage");
