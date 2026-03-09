import { describe, expect, it } from "vitest";
import {
  createComposerSkillSelection,
  insertComposerSkillSelection,
  reconcileComposerSkillSelections,
} from "./codexSkillSelections";

describe("createComposerSkillSelection", () => {
  it("computes the skill token range from the inserted name", () => {
    expect(
      createComposerSkillSelection({
        name: "code-review",
        path: "/tmp/code-review/SKILL.md",
        rangeStart: 4,
      }),
    ).toEqual({
      name: "code-review",
      path: "/tmp/code-review/SKILL.md",
      rangeStart: 4,
      rangeEnd: 16,
    });
  });
});

describe("reconcileComposerSkillSelections", () => {
  it("shifts ranges when text is inserted before the selection", () => {
    expect(
      reconcileComposerSkillSelections({
        previousPrompt: "Use $code-review now",
        nextPrompt: "Please use $code-review now",
        selections: [
          {
            name: "code-review",
            path: "/tmp/code-review/SKILL.md",
            rangeStart: 4,
            rangeEnd: 16,
          },
        ],
      }),
    ).toEqual([
      {
        name: "code-review",
        path: "/tmp/code-review/SKILL.md",
        rangeStart: 11,
        rangeEnd: 23,
      },
    ]);
  });

  it("drops selections whose token no longer exists", () => {
    expect(
      reconcileComposerSkillSelections({
        previousPrompt: "Use $code-review now",
        nextPrompt: "Use now",
        selections: [
          {
            name: "code-review",
            path: "/tmp/code-review/SKILL.md",
            rangeStart: 4,
            rangeEnd: 16,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps a newly inserted selection after replacing the active trigger", () => {
    expect(
      insertComposerSkillSelection({
        previousPrompt: "$cre",
        nextPrompt: "$create-pr ",
        selections: [],
        insertedSelection: createComposerSkillSelection({
          name: "create-pr",
          path: "/tmp/create-pr/SKILL.md",
          rangeStart: 0,
        }),
      }),
    ).toEqual([
      {
        name: "create-pr",
        path: "/tmp/create-pr/SKILL.md",
        rangeStart: 0,
        rangeEnd: 10,
      },
    ]);
  });
});
