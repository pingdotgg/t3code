import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Private Effect-native Cloud Run Service (invoker IAM enforced).
 * Called by {@link ./invoke-caller.ts} from {@link ../InvokeService.test.ts}.
 */
export default class InvokeCallee extends GCP.Function<InvokeCallee>()(
  "InvokeCallee",
  {
    main: import.meta.url,
    location: "us-central1",
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const body = request.method === "POST" ? yield* request.text : "";
        return yield* HttpServerResponse.json({
          from: "callee",
          method: request.method,
          path: new URL(request.originalUrl, "http://localhost").pathname,
          body,
        });
      }),
    };
  }),
) {}
