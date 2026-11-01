import { assert, describe, it } from "@effect/vitest";

import { defaultSkillEvalArms } from "./skillEvals.ts";

describe("defaultSkillEvalArms", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly input: Parameters<typeof defaultSkillEvalArms>[0];
    readonly expected: ReturnType<typeof defaultSkillEvalArms>;
  }> = [
    {
      name: "current variant against off",
      input: { effectiveMode: "variant" as const, ruleId: "rule-variant" },
      expected: [
        { armId: "off", label: "Off", kind: "off", role: "control" },
        {
          armId: "variant",
          label: "Current variant",
          kind: "variant",
          ruleId: "rule-variant",
          role: "treatment",
        },
      ],
    },
    {
      name: "current off rule against base",
      input: { effectiveMode: "off" as const, ruleId: "rule-off" },
      expected: [
        { armId: "base", label: "Base", kind: "base", role: "control" },
        {
          armId: "off",
          label: "Current off rule",
          kind: "off",
          ruleId: "rule-off",
          role: "treatment",
        },
      ],
    },
    {
      name: "base against off",
      input: { effectiveMode: "base" as const, ruleId: null },
      expected: [
        { armId: "off", label: "Off", kind: "off", role: "control" },
        { armId: "base", label: "Base", kind: "base", role: "treatment" },
      ],
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    assert.deepStrictEqual(defaultSkillEvalArms(input), expected);
  });
});
