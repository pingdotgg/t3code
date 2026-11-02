import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  makePersistedServerRuntimeState,
  PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { describeRunningServer } from "./policy.ts";

const encodeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

it.layer(NodeServices.layer)((it) =>
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
  ),
);
