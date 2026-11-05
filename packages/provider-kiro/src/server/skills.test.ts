import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { kiroSkillCommandText, makeKiroSkills, recordKiroSkills } from "./skills.ts";

const skill = (name: string) => ({
  name,
  description: `${name} skill`,
  _meta: { kiro: { type: "skill" } },
});
const agent = (name: string) => ({
  name,
  description: "",
  _meta: { kiro: { type: "custom-agent" } },
});

describe("recordKiroSkills", () => {
  it.effect("keeps only skill commands, once each", () =>
    Effect.gen(function* () {
      const skills = yield* makeKiroSkills();
      yield* recordKiroSkills(skills, [
        skill("deploy"),
        skill("Deploy"),
        agent("reviewer"),
        { name: "compact", description: "Compact the conversation" },
      ]);
      assert.deepEqual(
        (yield* SubscriptionRef.get(skills)).map(({ name, path }) => ({ name, path })),
        [{ name: "deploy", path: "acp://skill/deploy" }],
      );
    }),
  );

  it.effect("keeps skills from earlier sessions and updates without skills", () =>
    Effect.gen(function* () {
      const skills = yield* makeKiroSkills();
      yield* recordKiroSkills(skills, [skill("deploy-a")]);
      yield* recordKiroSkills(skills, [skill("deploy-b")]);
      const merged = yield* SubscriptionRef.get(skills);
      yield* recordKiroSkills(skills, [agent("reviewer")]);
      assert.strictEqual(yield* SubscriptionRef.get(skills), merged);
      assert.deepEqual(
        merged.map(({ name }) => name),
        ["deploy-a", "deploy-b"],
      );
    }),
  );
});

describe("kiroSkillCommandText", () => {
  it.effect("rewrites only a leading mention of an advertised skill", () =>
    Effect.gen(function* () {
      const skills = yield* makeKiroSkills();
      yield* recordKiroSkills(skills, [skill("deploy")]);
      assert.equal(yield* kiroSkillCommandText(skills, "  $deploy now"), "/deploy now");
      assert.equal(yield* kiroSkillCommandText(skills, "$deployer now"), "$deployer now");
      assert.equal(yield* kiroSkillCommandText(skills, "$25 please"), "$25 please");
      assert.equal(yield* kiroSkillCommandText(skills, "run $deploy"), "run $deploy");
    }),
  );
});
