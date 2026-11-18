import { assert, describe, it } from "@effect/vitest";

import { skillGroupFromSkillFile } from "./skillGroup.ts";

describe("skillGroupFromSkillFile", () => {
  it("reads the group and its order from the metadata map", () => {
    const cases: ReadonlyArray<[string, ReturnType<typeof skillGroupFromSkillFile>]> = [
      ['metadata:\n  group: " Design "\n  group-order: "3"', { group: "Design", groupOrder: 3 }],
      ["metadata:\n  group: Ship\n  group-order: 7", { group: "Ship", groupOrder: 7 }],
      ["metadata:\n  group: Ship\n  group-order: soon", { group: "Ship" }],
      ['metadata:\n  group: Ship\n  group-order: ""', { group: "Ship" }],
      ['metadata:\n  group-order: "2"', {}],
      ["group: Ship", {}],
      ["metadata: [unclosed", {}],
    ];
    for (const [frontmatter, expected] of cases) {
      assert.deepEqual(skillGroupFromSkillFile(`---\n${frontmatter}\n---\n# Body`), expected);
    }
    assert.deepEqual(skillGroupFromSkillFile("# No frontmatter"), {});
  });
});
