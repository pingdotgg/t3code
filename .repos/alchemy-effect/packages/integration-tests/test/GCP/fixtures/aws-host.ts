import * as Lambda from "@alchemy.run/aws/Lambda";
import * as GCP from "@alchemy.run/gcp";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import path from "pathe";

/** Topic the Lambda publishes to. */
export const Events = GCP.PubSub.Topic("FederatedEvents", {});

export class FederatedLambda extends Lambda.Function<Lambda.Function>()("FederatedLambda") {}

/**
 * An AWS Lambda publishing to a GCP topic. It runs as an IAM role, so it
 * reaches Pub/Sub by exchanging its AWS identity for a service account's
 * token, not with a service account key. Deployed from
 * {@link ../GCPBindings.test.ts}.
 */
export default FederatedLambda.make(
  {
    main: path.resolve(import.meta.dirname, "aws-host.ts"),
    functionUrl: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const publish = yield* GCP.PubSub.Publish(yield* Events);
    return {
      fetch: publish({ body: { messages: [{ data: btoa("hello from lambda") }] } }).pipe(
        Effect.flatMap((response) => HttpServerResponse.json(response)),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: Cause.pretty(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(GCP.PubSub.PublishHttp)),
);
