import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { kiroSkillCommandText, makeKiroSkills, recordKiroSkills } from "./skills.ts";

const skill = (name: string, source?: { readonly origin: string; readonly root?: string }) => ({
  name,
  description: `${name} skill`,
  _meta: {
    kiro: {
      type: "skill",
      ...(source === undefined ? {} : { resource: { resourceType: "skill", source } }),
    },
  },
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

  // Shaped like kiro-cli 3.0.0, which lists `<cwd>/.kiro/skills` beside `~/.kiro/skills`.
  it.effect("leaves out skills Kiro scopes to a workspace", () =>
    Effect.gen(function* () {
      const skills = yield* makeKiroSkills();
      yield* recordKiroSkills(skills, [
        skill("project-skill", { origin: "workspace", root: "/abs/project/path" }),
        skill("user-skill", { origin: "user" }),
      ]);
      assert.deepEqual(
        (yield* SubscriptionRef.get(skills)).map(({ name }) => name),
        ["user-skill"],
      );
      assert.equal(yield* kiroSkillCommandText(skills, "$project-skill x"), "$project-skill x");
      assert.equal(yield* kiroSkillCommandText(skills, "$user-skill x"), "/user-skill x");
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
