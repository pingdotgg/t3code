import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ChatAttachment, OpenCode2Settings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import * as OpenCode2Runtime from "../provider/opencode2Runtime.ts";
import * as SpawnedProcessReaper from "../provider/SpawnedProcessReaper.ts";
import { makeOpenCode2TextGeneration } from "./OpenCode2TextGeneration.ts";

const decodeOpenCode2Settings = Schema.decodeUnknownEffect(OpenCode2Settings);
const decodeChatAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const layer = OpenCode2Runtime.layer.pipe(
  Layer.provide(SpawnedProcessReaper.layer),
  Layer.provide(NodeServices.layer),
);

describe.runIf(process.env.T3_OPENCODE2_LIVE === "1")("OpenCode 2 text generation (live)", () => {
  it.live(
    "generates text and attachment-metadata titles with the selected model",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const settings = yield* decodeOpenCode2Settings({
            binaryPath: "opencode2",
          });
          const textGeneration = yield* makeOpenCode2TextGeneration(settings);
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Add deterministic OpenCode 2 text generation coverage.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("opencode2-live"),
              model: "opencode/glm-5.2",
            },
          });

          assert.isAbove(result.title.length, 0);
          assert.isAtMost(result.title.length, 50);

          const attachment = yield* decodeChatAttachment({
            type: "image",
            id: "opencode2-live-12345678-1234-1234-1234-123456789abc",
            name: "green-pixel.png",
            mimeType: "image/png",
            sizeBytes: 68,
          });
          const attachmentResult = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread for a green image attachment test.",
            attachments: [attachment],
            modelSelection: {
              instanceId: ProviderInstanceId.make("opencode2-live"),
              model: "opencode/glm-5.2",
            },
          });

          assert.isAbove(attachmentResult.title.length, 0);
          assert.isAtMost(attachmentResult.title.length, 50);

          const agentResult = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread for an agent-bound generation test.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("opencode2-live"),
              model: "opencode/glm-5.2",
              options: [{ id: "agent", value: "build" }],
            },
          });

          assert.isAbove(agentResult.title.length, 0);
          assert.isAtMost(agentResult.title.length, 50);
        }),
      ).pipe(Effect.provide(layer)),
    { timeout: 120_000 },
  );
});
