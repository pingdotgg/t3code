import { assert, it } from "@effect/vitest";

import { hasCodexSkillMention, resolveCodexSkillMentions } from "./CodexSkillDispatch.ts";

const skills = [
  { name: "ask-matt", path: "/home/theo/.agents/skills/ask-matt/SKILL.md", enabled: true },
  { name: "release", path: "/home/theo/.agents/skills/release/SKILL.md", enabled: true },
  { name: "retired", path: "/home/theo/.agents/skills/retired/SKILL.md", enabled: false },
];

it("gates the catalog read on a skill token", () => {
  assert.isTrue(hasCodexSkillMention("$ask-matt which flow fits?"));
  assert.isTrue(hasCodexSkillMention("please run $release"));
  assert.isFalse(hasCodexSkillMention("costs $5 and echo $ is fine"));
  assert.isFalse(hasCodexSkillMention("email me@$host"));
});

it("resolves each mentioned skill once, in first-mention order", () => {
  assert.deepEqual(
    resolveCodexSkillMentions("$release then $ask-matt and $release again", skills),
    [
      { name: "release", path: "/home/theo/.agents/skills/release/SKILL.md" },
      { name: "ask-matt", path: "/home/theo/.agents/skills/ask-matt/SKILL.md" },
    ],
  );
});

it("leaves unknown and disabled mentions as prose", () => {
  assert.deepEqual(resolveCodexSkillMentions("set $HOME and try $retired", skills), []);
  assert.deepEqual(resolveCodexSkillMentions("no tokens here", skills), []);
  // A token is whitespace-delimited, as the composer chip is.
  assert.deepEqual(resolveCodexSkillMentions("$ask-matt, please", skills), []);
});
