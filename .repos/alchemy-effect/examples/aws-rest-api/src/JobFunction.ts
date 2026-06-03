import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const main = import.meta.filename;

/**
 * Minimal Lambda for API Gateway `AWS_PROXY` — returns plain text.
 */
export default class JobFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "JobFunction",
  {
    main,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello from REST API + Lambda");
      }),
    };
  }),
) {}
