import { describe, expect, it } from "vite-plus/test";

import { bindCodexSkillInvocations } from "./codexSkillInvocations.ts";

const grillWithDocs = {
  name: "grill-with-docs",
  path: "/Users/me/.agents/skills/grill-with-docs/SKILL.md",
  enabled: true,
};

const grilling = {
  name: "grilling",
  path: "/Users/me/.agents/skills/grilling/SKILL.md",
  enabled: true,
};

describe("bindCodexSkillInvocations", () => {
  it("attaches a known enabled skill as a structured skill item", () => {
    expect(
      bindCodexSkillInvocations("$grill-with-docs explain why this skill is not in the list", [
        grillWithDocs,
        grilling,
      ]),
    ).toEqual({
      ok: true,
      inputs: [
        {
          type: "skill",
          name: "grill-with-docs",
          path: grillWithDocs.path,
        },
      ],
    });
  });

  it("attaches a user-invoked-only skill when it is enabled in the list", () => {
    expect(bindCodexSkillInvocations("Use $grill-with-docs please", [grillWithDocs])).toEqual({
      ok: true,
      inputs: [
        {
          type: "skill",
          name: "grill-with-docs",
          path: grillWithDocs.path,
        },
      ],
    });
  });

  it("attaches an explicit token even when the listed skill is disabled", () => {
    expect(
      bindCodexSkillInvocations("$grill-with-docs go", [{ ...grillWithDocs, enabled: false }]),
    ).toEqual({
      ok: true,
      inputs: [
        {
          type: "skill",
          name: "grill-with-docs",
          path: grillWithDocs.path,
        },
      ],
    });
  });

  it("returns unknown names instead of attaching a silent token", () => {
    expect(bindCodexSkillInvocations("$missing-skill do this", [grillWithDocs])).toEqual({
      ok: false,
      names: ["missing-skill"],
    });
  });

  it("leaves messages without $skill tokens unchanged", () => {
    expect(bindCodexSkillInvocations("explain this change", [grillWithDocs])).toEqual({
      ok: true,
      inputs: [],
    });
    expect(bindCodexSkillInvocations("costs $100 please", [grillWithDocs])).toEqual({
      ok: true,
      inputs: [],
    });
    expect(bindCodexSkillInvocations(undefined, [grillWithDocs])).toEqual({
      ok: true,
      inputs: [],
    });
  });

  it("attaches each distinct skill once and keeps list order", () => {
    expect(
      bindCodexSkillInvocations("$grill-with-docs then $grilling then $grill-with-docs", [
        grillWithDocs,
        grilling,
      ]),
    ).toEqual({
      ok: true,
      inputs: [
        {
          type: "skill",
          name: "grill-with-docs",
          path: grillWithDocs.path,
        },
        {
          type: "skill",
          name: "grilling",
          path: grilling.path,
        },
      ],
    });
  });
});
