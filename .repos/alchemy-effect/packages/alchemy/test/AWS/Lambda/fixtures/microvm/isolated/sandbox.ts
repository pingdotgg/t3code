import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { isolatedProject } from "../../../../../IsolatedProject.ts";

/**
 * The isolated consumer project this image is bundled from (see
 * `test/IsolatedProject.ts`): `main` lives outside the repository, so the
 * bundle `cwd` resolves none of alchemy's dependencies and the MicroVM
 * bootstrap's own imports (`alchemy/*`, `effect/*`, …) must be anchored by
 * the bundler.
 */
export const project = isolatedProject("lambda-microvm", import.meta.filename);

export const IsolatedSandboxBuildRole = AWS.IAM.Role(
  "IsolatedProjectMicrovmBuildRole",
);

/**
 * Minimal effectful MicroVM image bundled from an isolated project: a typed
 * RPC method (`hello`) plus a raw `fetch` route (`/echo`). Either answering
 * from inside a running MicroVM proves the generated bootstrap booted — with
 * its imports left external the in-VM server dies at module load and the
 * orchestrator's calls never get a reply.
 */
export class IsolatedSandbox extends AWS.Lambda.MicrovmImage<
  IsolatedSandbox,
  {
    hello: (message: string) => Effect.Effect<string>;
  }
>()("IsolatedProjectMicrovmSandbox") {}

export default IsolatedSandbox.make(
  IsolatedSandboxBuildRole.pipe(
    Effect.map((buildRole) => ({
      main: project.main,
      buildRole,
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
            message: url.searchParams.get("message") ?? "",
          });
        }
        return HttpServerResponse.text("hello from isolated project");
      }),
      hello: (message: string) => Effect.succeed(`hello, ${message}!`),
    };
  }),
);
