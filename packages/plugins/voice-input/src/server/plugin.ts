import voiceInputManifestJson from "../manifest.json" with { type: "json" };
import { PluginManifest } from "@t3tools/plugin-api/manifest";
import { defineServerPlugin } from "@t3tools/plugin-api/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { registerVoiceInputCollections, registerVoiceInputCommands } from "./commands.ts";

const voiceInputManifest = Schema.decodeUnknownSync(PluginManifest)(voiceInputManifestJson);

export const voiceInputPlugin = defineServerPlugin({
  manifest: voiceInputManifest,
  activate: (ctx) =>
    Effect.gen(function* () {
      const collections = yield* registerVoiceInputCollections(ctx);
      yield* registerVoiceInputCommands(ctx, collections);
    }),
});
