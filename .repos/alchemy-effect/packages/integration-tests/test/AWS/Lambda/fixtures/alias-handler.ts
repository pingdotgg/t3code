import * as Lambda from "@alchemy.run/aws/Lambda";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// Host Function for the `alias` test: a function URL plus an SQS event
// source, so the test can check both follow the alias. `fetch` echoes the
// RELEASE_MARKER env var, which the test changes to publish a new version.
export class AliasFunction extends Lambda.Function<AliasFunction>()("AliasFunction") {}

export const aliasFunction = (alias: string | undefined) =>
  AliasFunction.make(
    {
      main: import.meta.url,
      functionUrl: true,
      alias,
    },
    Effect.gen(function* () {
      const queue = yield* SQS.Queue("AliasQueue");

      yield* SQS.consumeQueueMessages(queue, () => Effect.void);

      return {
        fetch: Effect.gen(function* () {
          const marker = yield* Effect.sync(() => process.env.RELEASE_MARKER);
          return HttpServerResponse.text(marker ?? "missing");
        }),
      };
    }).pipe(Effect.provide(Lambda.QueueEventSource)),
  );

export default aliasFunction(undefined);
