import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import InvokeCallee from "./invoke-callee.ts";

/**
 * Public Effect-native Cloud Run Service that calls the private
 * {@link InvokeCallee} through `GCP.Run.InvokeService`.
 */
export default class InvokeCaller extends GCP.Function<InvokeCaller>()(
  "InvokeCaller",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const callee = yield* GCP.Run.InvokeService(InvokeCallee);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.originalUrl, "http://localhost").pathname;
        const response =
          path === "/post"
            ? yield* callee.fetch("/echo", {
                method: "POST",
                headers: { "content-type": "text/plain" },
                body: "ping",
              })
            : yield* callee.fetch("/hello");
        return yield* HttpServerResponse.json({
          status: response.status,
          body: response.status === 200 ? yield* response.json : undefined,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(GCP.Run.InvokeServiceHttp)),
) {}
