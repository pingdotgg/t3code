import * as Lambda from "@alchemy.run/aws/Lambda";
import * as SQS from "@alchemy.run/aws/SQS";
import { ServerHost } from "alchemy/Runtime/Process";
// Web Functions only receive HTTP. These declarations must fail to type
// check and fail at plan rather than deploy something that never runs.
import * as Effect from "effect/Effect";

export class EventSourceWeb extends Lambda.WebFunction<Lambda.WebFunction>()("EventSourceWeb") {}

export const EventSourceWebLive = EventSourceWeb.make(
  { main: import.meta.url, authType: "ApplicationManaged" },
  // @ts-expect-error — Lambda event sources need an AWS.Lambda.Function host
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("WebEventSourceQueue");
    yield* SQS.consumeQueueMessages(queue, () => Effect.void);
    return {};
  }).pipe(Effect.provide(Lambda.QueueEventSource)),
);

export class BackgroundLoopWeb extends Lambda.WebFunction<Lambda.WebFunction>()(
  "BackgroundLoopWeb",
) {}

export const BackgroundLoopWebLive = BackgroundLoopWeb.make(
  { main: import.meta.url, authType: "ApplicationManaged" },
  // @ts-expect-error — a Web Function provides no ServerHost for background loops
  Effect.gen(function* () {
    const host = yield* ServerHost;
    yield* host.run(Effect.never);
    return {};
  }),
);
