import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const main = import.meta.url;

/** ALB Lambda target answering the `/api/*` path rule. */
export class ApiTargetFunction extends Lambda.Function<Lambda.Function>()(
  "ApiTargetFunction",
) {}

export const ApiTargetFunctionLive = ApiTargetFunction.make(
  {
    main,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;
        return yield* HttpServerResponse.json({
          target: "api",
          path: pathname,
        });
      }).pipe(Effect.orDie),
    };
  }),
);

export default ApiTargetFunctionLive;
