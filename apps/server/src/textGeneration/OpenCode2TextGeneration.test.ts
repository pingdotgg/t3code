import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as OpenCode2AdapterV2Testkit from "../orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts";
import * as OpenCode2Server from "../provider/opencode2/OpenCode2Server.ts";
import * as OpenCode2TextGeneration from "./OpenCode2TextGeneration.ts";
import { OPENCODE2_TITLE_GENERATION } from "./OpenCode2TextGeneration.fixture.ts";

const layer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-opencode2-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("OpenCode2TextGeneration", (it) => {
  it.effect("generates a title in a temporary session on the free tier and removes it", () =>
    Effect.gen(function* () {
      const server = yield* OpenCode2AdapterV2Testkit.replayServer({
        provider: "opencode",
        protocol: OpenCode2AdapterV2Testkit.OPENCODE2_HTTP_PROTOCOL,
        version: "2.0.18",
        scenario: "opencode2_title_generation",
        entries: [...OPENCODE2_TITLE_GENERATION, { type: "runtime_exit", status: "success" }],
      });
      const textGeneration = yield* OpenCode2TextGeneration.makeOpenCode2TextGeneration().pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, server),
      );
      const title = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "fix the login redirect loop after oauth",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode/big-pickle",
        },
      });
      assert.equal(title.title, "Fix OAuth Login Redirect Loop");
    }).pipe(Effect.scoped),
  );
});
