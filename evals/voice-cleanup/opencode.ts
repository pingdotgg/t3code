import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as OpenCodeRuntime from "../../packages/provider-opencode/src/server/OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "../../packages/provider-opencode/src/server/OpenCodeServerLedger.ts";
import * as OpenCode2Client from "../../packages/provider-opencode/src/server/v2/OpenCode2Client.ts";
import * as OpenCode2Server from "../../packages/provider-opencode/src/server/v2/OpenCode2Server.ts";
import * as OpenCodeTextGeneration from "../../packages/provider-opencode/src/server/v2/textGeneration.ts";
import * as TestProviderHost from "../../packages/provider-testing/src/TestProviderHost.ts";

export const makeOpenCodeTextGeneration = Effect.fn("voiceCleanup.makeOpenCodeTextGeneration")(
  function* (cwd: string) {
    const server = yield* OpenCode2Server.make({
      binaryPath: "opencode",
      serverUrl: "",
      serverPassword: "",
      directory: cwd,
      environment: process.env,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          OpenCode2Client.layer,
          OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layer({ stateDir: cwd }))),
        ),
      ),
    );
    return yield* OpenCodeTextGeneration.make().pipe(
      Effect.provideService(OpenCode2Server.OpenCode2Server, server),
      Effect.provide(TestProviderHost.layer({ cwd, runBackgroundWork: false })),
    );
  },
);
