import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { kiroSkillCommandText, kiroSkillsFromCommands, makeKiroSkills } from "./skills.ts";

const skill = (name: string) => ({
  name,
  description: `${name} skill`,
  _meta: { kiro: { type: "skill" } },
});

describe("kiroSkillsFromCommands", () => {
  it("keeps only skill commands, once each", () => {
    const skills = kiroSkillsFromCommands([
      skill("deploy"),
      skill("Deploy"),
      { name: "reviewer", description: "", _meta: { kiro: { type: "custom-agent" } } },
      { name: "compact", description: "Compact the conversation" },
    ]);
    assert.deepEqual(
      skills.map(({ name, path }) => ({ name, path })),
      [{ name: "deploy", path: "acp://skill/deploy" }],
    );
  });
});

describe("kiroSkillCommandText", () => {
  it.effect("rewrites only a leading mention of an advertised skill", () =>
    Effect.gen(function* () {
      const skills = yield* makeKiroSkills();
      yield* SubscriptionRef.set(skills, kiroSkillsFromCommands([skill("deploy")]));
      assert.equal(yield* kiroSkillCommandText(skills, "  $deploy now"), "/deploy now");
      assert.equal(yield* kiroSkillCommandText(skills, "$deployer now"), "$deployer now");
      assert.equal(yield* kiroSkillCommandText(skills, "$25 please"), "$25 please");
      assert.equal(yield* kiroSkillCommandText(skills, "run $deploy"), "run $deploy");
    }),
  );
});
