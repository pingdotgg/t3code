import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { MuseDriver } from "./driver.ts";

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("MuseDriver workspace skills", (it) => {
  it.effect(
    "uses the workspace catalog and propagates failed discovery, without probing when disabled",
    () =>
      Effect.gen(function* () {
        const workspaces: Array<string | undefined> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          const cwd =
            command._tag === "StandardCommand" && command.args.includes("skills")
              ? command.options?.cwd
              : undefined;
          if (cwd) workspaces.push(cwd);
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              // A failed version check keeps this test from opening a real MSP host.
              exitCode: Effect.succeed(
                ChildProcessSpawner.ExitCode(cwd && cwd !== "/failed" ? 0 : 1),
              ),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(
                Stream.make(
                  JSON.stringify({
                    skills: [
                      { name: "workspace", path: "skills/workspace/SKILL.md", scope: "project" },
                    ],
                  }),
                ),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const noHttp = HttpClient.make(() => Effect.die("No HTTP expected"));
        const create = (enabled: boolean) =>
          MuseDriver.create({
            instanceId: ProviderInstanceId.make("muse-test"),
            displayName: undefined,
            environment: [],
            enabled,
            config: { ...MuseDriver.defaultConfig(), binaryPath: "/fake/muse" },
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HttpClient.HttpClient, noHttp),
          );
        const enabled = yield* create(true);
        for (const cwd of ["/first", "/second"]) {
          const snapshot = yield* enabled.snapshotForCwd!(cwd);
          expect(snapshot.skills).toEqual([
            {
              name: "workspace",
              path: `${cwd}/skills/workspace/SKILL.md`,
              scope: "project",
              enabled: true,
            },
          ]);
        }
        const failure = yield* enabled.snapshotForCwd!("/failed").pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "ProviderDriverError", driver: "muse" });
        const disabled = yield* create(false);
        const machine = yield* disabled.snapshot.getSnapshot;
        expect(yield* disabled.snapshotForCwd!("/disabled")).toEqual(machine);
        expect(workspaces).toEqual(["/first", "/second", "/failed"]);
      }).pipe(Effect.scoped),
  );
});
