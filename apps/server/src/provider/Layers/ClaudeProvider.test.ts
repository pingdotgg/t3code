import { ClaudeSettings } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
} from "../ClaudeModelCatalog.testFixtures.ts";
import { makePendingClaudeProvider } from "./ClaudeProvider.ts";

/**
 * Test policy: the snapshot must stay independent of bundled manifest
 * contents, so this file only ever names slugs from the synthetic catalog.
 */

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

describe("Claude provider snapshot", () => {
  it.effect("lends gateway-prefixed custom models the options of their template", () =>
    Effect.gen(function* () {
      const draft = yield* makePendingClaudeProvider(
        decodeClaudeSettings({
          customModels: [
            `gateway/${SYNTHETIC_CLAUDE_CAPABLE_MODEL}`,
            "gateway/claude-synthetic-unlisted",
            SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
            `gateway/${SYNTHETIC_CLAUDE_COLLIDING_ALIAS}`,
            {
              slug: `gateway/${SYNTHETIC_CLAUDE_STANDARD_MODEL}`,
              name: "Declared",
              capabilities: {
                optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
              },
            },
          ],
        }),
        SYNTHETIC_CLAUDE_MODEL_CATALOG,
      );

      assert.deepStrictEqual(
        draft.models
          .filter((model) => model.isCustom)
          .map((model) => [
            model.slug,
            (model.capabilities?.optionDescriptors ?? []).map((descriptor) => descriptor.id),
          ]),
        [
          [`gateway/${SYNTHETIC_CLAUDE_CAPABLE_MODEL}`, ["effort", "fastMode", "contextWindow"]],
          ["gateway/claude-synthetic-unlisted", []],
          [SYNTHETIC_CLAUDE_COLLIDING_ALIAS, []],
          // The custom slug shadows the alias, so the gateway-prefixed slug stays opaque.
          [`gateway/${SYNTHETIC_CLAUDE_COLLIDING_ALIAS}`, []],
          // Declared capabilities win over the template this slug routes to.
          [`gateway/${SYNTHETIC_CLAUDE_STANDARD_MODEL}`, ["thinking"]],
        ],
      );
    }),
  );
});
