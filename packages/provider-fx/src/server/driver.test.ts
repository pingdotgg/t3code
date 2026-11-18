import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { FxSettings } from "../settings.ts";
import { FxDriver } from "./driver.ts";

const homeRelativeSettings = Schema.decodeSync(FxSettings)({ binaryPath: "~/.local/bin/fx" });

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

/** Records each spawned command and answers only `--version`. */
function recordingSpawner(launches: Array<string>) {
  return ChildProcessSpawner.make((command) => {
    const standard = ChildProcess.isStandardCommand(command);
    if (standard) launches.push(command.command);
    const version = standard && command.args.join(" ") === "--version";
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(version ? 0 : 2)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: version ? Stream.encodeText(Stream.make("fx 0.0.13\n")) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

it.layer(layerTest)("FxDriver binary path", (it) => {
  it.effect("probes a ~/ binary path from the home directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const launches: Array<string> = [];
      const instance = yield* FxDriver.create({
        instanceId: ProviderInstanceId.make("fx-home"),
        displayName: undefined,
        enabled: true,
        environment: [],
        config: homeRelativeSettings,
      }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner(launches)),
      );
      const snapshot = yield* instance.snapshot.refresh;
      assert.isNotEmpty(launches);
      assert.deepEqual([...new Set(launches)], [path.join("/test-home", ".local", "bin", "fx")]);
      assert.isTrue(snapshot.installed);
    }),
  );
});
