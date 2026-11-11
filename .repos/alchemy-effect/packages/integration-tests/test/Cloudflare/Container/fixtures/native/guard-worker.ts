import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const GuardImage = Cloudflare.Container("GuardImage", {
  schedulingPolicy: "durable_object",
  image: "alpine:3.19",
});

/** An Effect-native class: its Containers must be bound with `yield*`. */
export class GuardObject extends Cloudflare.DurableObject<GuardObject>()(
  "GuardObject",
  Effect.gen(function* () {
    return Effect.succeed({});
  }),
) {}

/**
 * Invalid on purpose: the env binding lists containers for the Effect-native
 * `GuardObject` class this Worker implements.
 */
export const GuardWorker = Cloudflare.Worker(
  "GuardWorker",
  {
    main: import.meta.url,
    env: {
      GUARDED: Cloudflare.DurableObject("GuardObject", { containers: [GuardImage] }),
    },
  },
  Effect.gen(function* () {
    yield* GuardObject;
    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }),
);

export default GuardWorker;
