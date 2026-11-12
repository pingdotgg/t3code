import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * A public service that returns RPC methods. Its deploy must fail with
 * `GCP.Run.ServiceRpcPublic`. Deployed from {@link ../InvokeService.test.ts}.
 */
export default class PublicRpc extends GCP.Run.Service<PublicRpc>()(
  "PublicRpc",
  {
    main: import.meta.url,
    location: "us-central1",
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    return {
      secret: () => Effect.succeed("should never be public"),
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
