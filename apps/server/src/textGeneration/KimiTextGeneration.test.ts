// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { KimiSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeKimiTextGeneration } from "./KimiTextGeneration.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

const KimiTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kimi-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(KimiTextGenerationTestLayer)("KimiTextGeneration", (it) => {
  it.effect("uses the Kimi ACP runtime to generate and decode a commit message", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeKimiTextGeneration(
        decodeKimiSettings({
          binaryPath: process.execPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI launch argument is a fixture path.
          launchArgs: JSON.stringify(mockAgentPath),
        }),
        {
          ...process.env,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - ACP fixture response must be encoded as text.
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            subject: "Add Kimi provider",
            body: "Register the Kimi ACP text-generation path.",
          }),
        },
      );

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/kimi",
        stagedSummary: "M apps/server/src/provider/Drivers/KimiDriver.ts",
        stagedPatch: "diff --git a/.../KimiDriver.ts b/.../KimiDriver.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("kimi"), "default"),
      });

      expect(generated).toEqual({
        subject: "Add Kimi provider",
        body: "Register the Kimi ACP text-generation path.",
      });
    }),
  );
});
