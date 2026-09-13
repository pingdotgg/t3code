import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";

function emptyProcessHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("resolveNativeAppIcon", () => {
  it.effect("escapes Spotlight wildcards and caches misses", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const input = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        commands.push(input);
        return emptyProcessHandle();
      }),
    );
    const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-native-app-icon-test-",
    });
    const dependencies = Layer.mergeAll(
      configLayer,
      Layer.succeed(HostProcessPlatform, "darwin"),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const testLayer = NativeAppIconResolver.layer.pipe(Layer.provide(dependencies));
    const app = { _tag: "display-name", displayName: "Review * App" } as const;

    return Effect.gen(function* () {
      const resolver = yield* NativeAppIconResolver.NativeAppIconResolver;
      expect(yield* resolver.resolve(app)).toBeNull();
      expect(yield* resolver.resolve(app)).toBeNull();

      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ command: "/usr/bin/mdfind" });
      expect(commands[0]?.args[0]).toContain("Review \\* App");

      for (let index = 0; index < 256; index += 1) {
        expect(
          yield* resolver.resolve({
            _tag: "display-name",
            displayName: `Missing Review App ${index}`,
          }),
        ).toBeNull();
      }
      expect(commands).toHaveLength(257);
      expect(yield* resolver.resolve(app)).toBeNull();
      expect(commands).toHaveLength(258);
    }).pipe(Effect.provide(testLayer));
  });
});
