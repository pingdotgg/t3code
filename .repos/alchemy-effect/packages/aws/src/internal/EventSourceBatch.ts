import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpTraceContext from "effect/http/HttpTraceContext";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

/**
 * Link a producer context carried in a W3C `traceparent` (e.g. an SQS
 * message attribute) to the batch's consumer span.
 */
export const traceparentLink = (traceparent: string | undefined): Option.Option<Tracer.SpanLink> =>
  traceparent === undefined
    ? Option.none()
    : HttpTraceContext.fromHeaders(Headers.fromInput({ traceparent })).pipe(
        Option.map((span) => ({ span, attributes: {} })),
      );

/**
 * Wrap one delivered event-source batch in a `process <destination>`
 * CONSUMER span (OTEL messaging semconv) linked to each record's producer
 * context, and log the cause when the handler fails so a whole-batch retry
 * is never silent.
 */
export const processBatch =
  (options: {
    readonly system: string;
    readonly destination: string;
    readonly count: number;
    readonly links?: ReadonlyArray<Tracer.SpanLink>;
  }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.tapCause((cause) =>
        Effect.logError(
          `${options.system} batch of ${options.count} from ${options.destination} failed; the whole batch will be retried`,
          cause,
        ),
      ),
      Effect.withSpan(`process ${options.destination}`, {
        kind: "consumer",
        links: options.links,
        attributes: {
          "messaging.system": options.system,
          "messaging.operation.type": "process",
          "messaging.operation.name": "process",
          "messaging.destination.name": options.destination,
          "messaging.batch.message_count": options.count,
        },
      }),
    );
