import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { VM_MARKER } from "./vm/marker.ts";

/** Bare role; the image grants it the trust + build permissions it needs. */
export const ShellBuildRole = AWS.IAM.Role("StressMicrovmBuildRole");

/**
 * An **effectful** AWS Lambda MicroVM image: this module is both the image
 * declaration and the program that runs INSIDE the VM. Under `alchemy dev`
 * the image is built and the VMs are booted by the floci emulator, as real
 * Docker containers.
 *
 * It is the most expensive resource in the stack by a wide margin, which is
 * exactly why it is here: the stress suite asserts that all the churn it
 * inflicts elsewhere never rebuilds this image.
 *
 * Exposes both halves of the MicroVM protocol so the Worker can drive
 * either: a raw `fetch` route (`/echo`) and a typed RPC method (`hello`).
 */
export class ShellMicrovm extends AWS.Lambda.MicrovmImage<
  ShellMicrovm,
  {
    hello: (message: string) => Effect.Effect<string>;
  }
>()("StressMicrovm") {}

export default ShellMicrovm.make(
  ShellBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: import.meta.filename,
      buildRole,
      runtime: "bun" as const,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
    })),
  ),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm");
        if (url.pathname === "/echo") {
          return yield* HttpServerResponse.json({
            marker: VM_MARKER,
            message: url.searchParams.get("message") ?? "",
          });
        }
        return HttpServerResponse.text(VM_MARKER);
      }),
      hello: (message: string) => Effect.succeed(`hello, ${message}!`),
    };
  }),
);
