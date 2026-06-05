import automationsManifestJson from "../manifest.json" with { type: "json" };
import { PluginManifest } from "@t3tools/plugin-api/manifest";
import { defineServerPlugin } from "@t3tools/plugin-api/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { registerAutomationCommands } from "./commands.ts";
import { PLACEMENT_MAIN_SIDEBAR } from "./constants.ts";
import {
  makeAutomationsRuntime,
  registerAutomationCollections,
  startAutomationScheduleLoop,
} from "./runtime.ts";

const automationsManifest = Schema.decodeUnknownSync(PluginManifest)(automationsManifestJson);

export const automationsPlugin = defineServerPlugin({
  manifest: automationsManifest,
  activate: (ctx) =>
    Effect.gen(function* () {
      const collections = yield* registerAutomationCollections(ctx);
      const runtime = yield* makeAutomationsRuntime(ctx, collections);
      yield* runtime.markInterruptedRunsFailed;
      yield* startAutomationScheduleLoop(runtime);

      yield* ctx.ui.setPlacementBadgeProvider(
        PLACEMENT_MAIN_SIDEBAR,
        runtime.countFailedOrSkippedRuns,
      );
      yield* registerAutomationCommands(ctx, runtime, collections);
    }),
});
