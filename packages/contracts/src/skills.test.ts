import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { SkillSearchInput, WS_METHODS } from "./index.ts";

const decodeSkillSearchInput = Schema.decodeUnknownEffect(SkillSearchInput);

it.effect("trims skill search input", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeSkillSearchInput({
      cwd: " /tmp/project ",
      query: " $agent-browser ",
      limit: 25,
      codexHomePath: " ~/.codex ",
      extraRoots: [" ~/workspace-skills "],
    });
    assert.strictEqual(parsed.cwd, "/tmp/project");
    assert.strictEqual(parsed.query, "$agent-browser");
    assert.strictEqual(parsed.codexHomePath, "~/.codex");
    assert.deepStrictEqual(parsed.extraRoots, ["~/workspace-skills"]);
  }),
);

it.effect("exports skills rpc method id", () =>
  Effect.sync(() => {
    assert.strictEqual(WS_METHODS.skillsSearch, "skills.search");
  }),
);
