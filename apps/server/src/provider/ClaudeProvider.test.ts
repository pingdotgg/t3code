import { describe, expect, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makePendingClaudeProvider } from "./ClaudeProvider.ts";

const defaultSettings = Schema.decodeSync(ClaudeSettings)({});

describe("makePendingClaudeProvider", () => {
  it.effect("lists Auto Low, Medium and High after the real models, with no settings", () =>
    Effect.gen(function* () {
      const provider = yield* makePendingClaudeProvider(defaultSettings);
      expect(provider.models[0]?.slug).toMatch(/^claude-/);
      expect(provider.models.slice(-3).map((model) => [model.slug, model.name])).toEqual([
        ["auto-low", "Auto Low"],
        ["auto-medium", "Auto Medium"],
        ["auto-high", "Auto High"],
      ]);
    }),
  );
});
