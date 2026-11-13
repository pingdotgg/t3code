import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeURL from "node:url";
import { makeCodexLiveVoice } from "./CodexLiveVoice.ts";

const config = Schema.decodeSync(CodexSettings)({ binaryPath: process.execPath });
const peer = NodeURL.fileURLToPath(
  new URL(
    "../../../../packages/effect-codex-app-server/test/fixtures/codex-app-server-mock-peer.ts",
    import.meta.url,
  ),
);
it.layer(Layer.merge(NodeServices.layer, FetchHttpClient.layer))(
  "Codex subscription authentication",
  (it) => {
    it.effect("rejects an API-key provider before attempting a voice request", () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const voice = yield* makeCodexLiveVoice(Effect.succeed({ config, environment: {} })).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
            ...spawner,
            spawn: () =>
              spawner.spawn(
                ChildProcess.make(process.execPath, [peer], {
                  env: { CODEX_APP_SERVER_TEST_ACCOUNT: "apiKey" },
                  extendEnv: true,
                }),
              ),
          }),
        );
        const error = yield* voice.options.pipe(Effect.flip);
        assert.equal(error.reason, "authentication");
      }),
    );
  },
);
