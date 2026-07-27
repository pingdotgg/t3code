import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const SandboxBuildRole = AWS.IAM.Role("MicrovmSandboxBuildRole");

/**
 * Effectful MicroVM image exposing BOTH a raw `fetch` handler and a typed RPC
 * `Shape` (the `hello` method). The runtime serves the RPC methods over the
 * `/__rpc__/*` protocol and falls through to `fetch` for everything else;
 * callers reach RPC with {@link AWS.Lambda.connectMicrovm} and `fetch` with a
 * plain HTTPS request to the MicroVM endpoint.
 *
 * The class (a typed handle) is imported by the Lambda orchestrator; the
 * `.make()` Live layer is provided on the stack and is what gets bundled into
 * the image.
 */
export class Sandbox extends AWS.Lambda.MicrovmImage<
  Sandbox,
  {
    hello: (message: string) => Effect.Effect<string>;
  }
>()("MicrovmSandbox") {}

export default Sandbox.make(
  SandboxBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      buildRole,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  Effect.gen(function* () {
    return {
      // Raw HTTP route (the fetch path).
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm");
        if (url.pathname === "/echo") {
          return yield* HttpServerResponse.json({
            message: url.searchParams.get("message") ?? "",
          });
        }
        return HttpServerResponse.text("hello from effectful microvm");
      }),
      // Tagged RPC method (the RPC path).
      hello: (message: string) => Effect.succeed(`hello, ${message}!`),
    };
  }),
);
