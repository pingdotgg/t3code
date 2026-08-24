import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const main = import.meta.url;

/**
 * Minimal Lambda used as the Object Lambda transform target. The Object
 * Lambda Access Point lifecycle only stores/validates the function ARN, so
 * the handler body is irrelevant for the lifecycle tests.
 */
export class ObjectTransformFunction extends Lambda.Function<Lambda.Function>()(
  "ObjectTransformFunction",
) {}

export const ObjectTransformFunctionLive = ObjectTransformFunction.make(
  {
    main,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }),
);

export default ObjectTransformFunctionLive;
