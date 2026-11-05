import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  makePersistedServerRuntimeState,
  PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { describeRunningServer, readRunningServer } from "./policy.ts";

const encodeState = Schema.encodeEffect(Schema.fromJsonString(PersistedServerRuntimeState));

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))((it) =>
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
          return yield* readRunningServer(statePath, current);
        });
      const expectServer = (
        server: Effect.Success<ReturnType<typeof readRunningServer>>,
        status: typeof server.status,
        text: string,
      ) => {
        assert.equal(server.status, status);
        assert.include(describeRunningServer(server), text);
      };

      expectServer(
        yield* readRunningServer(statePath, installed),
        "not-running",
        "No T3 Code server",
      );
      expectServer(yield* running(installed), "current", "loaded this policy.");
      expectServer(
        yield* running(yield* loaded("Other Corp")),
        "restart-required",
        "loaded Other Corp's policy from /etc/t3code/policy.json",
      );
      expectServer(yield* running(null), "restart-required", "loaded no policy. Restart T3 Code");
      expectServer(yield* running(installed, null), "restart-required", "Restart T3 Code to apply");
      expectServer(yield* running(null, null), "current", "runs without a policy, as installed");
      expectServer(yield* running(undefined), "unknown", "does not report which policy it loaded");
    }),
  ),
);
