import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as ManagedNodeRuntime from "./ManagedNodeRuntime.ts";

it.layer(NodeServices.layer)("managed extension runtime", (it) => {
  it.effect(
    "rejects an unverified archive before extraction and removes its partial download",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-node-" });
        const requested: string[] = [];
        const client = HttpClient.make((request) => {
          requested.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("corrupt archive")),
          );
        });
        const result = yield* ManagedNodeRuntime.ensure(directory).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: () => Effect.die("An unverified archive must not execute or extract."),
          }),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.result,
        );
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.include(result.failure.message, "checksum");
        assert.deepEqual(requested, [
          `https://nodejs.org/dist/v${ManagedNodeRuntime.NODE_VERSION}/node-v${ManagedNodeRuntime.NODE_VERSION}-linux-x64.tar.gz`,
        ]);
        assert.deepEqual(yield* fs.readDirectory(directory), []);
      }),
  );
});
