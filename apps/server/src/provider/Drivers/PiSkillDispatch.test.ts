import { describe, expect, it } from "vite-plus/test";

import { planPiSkillDispatch } from "./PiSkillDispatch.ts";

const SKILLS = new Set(["html-communicator", "review", "re-release-version"]);

describe("planPiSkillDispatch", () => {
  it("leaves prompts without a discovered Pi skill unchanged", () => {
    expect(planPiSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    expect(planPiSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("turns a leading composer skill mention into Pi's native command", () => {
    expect(planPiSkillDispatch("$html-communicator create a report", SKILLS)).toEqual({
      commandText: "/skill:html-communicator create a report",
      skillName: "html-communicator",
    });
  });

  it("keeps all prose when the selected skill appears mid-prompt", () => {
    expect(planPiSkillDispatch("please $review focus on auth", SKILLS)).toEqual({
      commandText: "/skill:review please focus on auth",
      skillName: "review",
    });
  });

  it("dispatches the last known skill and preserves earlier mentions as arguments", () => {
    expect(
      planPiSkillDispatch("$review the diff, then $html-communicator report it", SKILLS),
    ).toEqual({
      commandText: "/skill:html-communicator /skill:review the diff, then report it",
      skillName: "html-communicator",
    });
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planPiSkillDispatch("cost is 5$review", SKILLS)).toBeUndefined();
  });
});
