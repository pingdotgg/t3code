import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  makePersistedServerRuntimeState,
  PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { describeRunningServer } from "./policy.ts";

const encodeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))((it) => {
  it.effect("tells whether the running server loaded the installed policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const statePath = (yield* Path.Path).join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-policy-show-" }),
        "server-runtime.json",
      );
      const loaded = (organization: string) =>
        ManagedPolicy.loadedPolicy({
          path: "/etc/t3code/policy.json",
          document: { schemaVersion: 1, organization },
        });
      const installed = yield* loaded("Example Corp");
      // A live server (this process) that loaded `managedPolicy`; undefined is an older server.
      const running = (managedPolicy: typeof installed | undefined, current = installed) =>
        Effect.gen(function* () {
          const state = yield* makePersistedServerRuntimeState({
            config: { host: undefined, devUrl: undefined },
            port: 3773,
            ...(managedPolicy === undefined ? {} : { managedPolicy }),
          });
          yield* fs.writeFileString(statePath, yield* encodeState(state));
          return yield* describeRunningServer(statePath, current);
        });

      assert.include(yield* describeRunningServer(statePath, installed), "No T3 Code server");
      assert.include(yield* running(installed), "loaded this policy.");
      assert.include(
        yield* running(yield* loaded("Other Corp")),
        "loaded Other Corp's policy from /etc/t3code/policy.json",
      );
      assert.include(yield* running(null), "loaded no policy. Restart T3 Code");
      assert.include(yield* running(installed, null), "Restart T3 Code to apply");
      assert.include(yield* running(null, null), "runs without a policy, as installed");
      assert.include(yield* running(undefined), "does not report which policy it loaded");
    }),
  );

  it.effect("templates expands ~/ in the output directory and --policy file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-policy-templates-" });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-policy-templates-cwd-" });
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.cwd();
          process.chdir(cwd);
          return previous;
        }),
        (previous) => Effect.sync(() => process.chdir(previous)),
      );
      yield* fs.writeFileString(
        path.join(home, "policy.json"),
        JSON.stringify({ schemaVersion: 1, organization: "Tilde Corp" }),
      );

      yield* Command.runWith(cli, { version: "0.0.0" })([
        "policy",
        "templates",
        "~/out",
        "--policy=~/policy.json",
      ]).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provide(NetService.layer),
      );

      assert.include(
        yield* fs.readFileString(path.join(home, "out", "macos", "t3code.mobileconfig")),
        "Tilde Corp",
      );
    }),
  );

  it.effect("check reads a ~/ policy file from the home directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-policy-check-" });
      const file = path.join(home, "policy.json");
      yield* fs.writeFileString(
        file,
        JSON.stringify({ schemaVersion: 1, organization: "Tilde Corp" }),
      );

      yield* Command.runWith(cli, { version: "0.0.0" })(["policy", "check", "~/policy.json"]).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provide(NetService.layer),
      );

      assert.include((yield* TestConsole.logLines).join("\n"), `Managed by Tilde Corp (${file}`);
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );
});
