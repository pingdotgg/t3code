import { describe, expect, it } from "vite-plus/test";

import { planPiSkillDispatch } from "./PiSkillDispatch.ts";

const SKILLS = new Set([
  "html-communicator",
  "review",
  "re-release-version",
  "review.v2",
  "réviser",
  "123-review",
]);

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

  it("supports dotted names with punctuation delimiters", () => {
    expect(planPiSkillDispatch("please ($review.v2), thanks", SKILLS)).toEqual({
      commandText: "/skill:review.v2 please ( ), thanks",
      skillName: "review.v2",
    });
    expect(planPiSkillDispatch("please use $review.v2. now", SKILLS)).toEqual({
      commandText: "/skill:review.v2 please use . now",
      skillName: "review.v2",
    });
  });

  it("does not accept a dotted extension on an otherwise known skill", () => {
    expect(planPiSkillDispatch("keep $review.extra as prose", SKILLS)).toBeUndefined();
    expect(planPiSkillDispatch("cost is 5$review.v2", SKILLS)).toBeUndefined();
  });

  it("keeps punctuation outside earlier inline skill commands", () => {
    expect(planPiSkillDispatch("$review. then $html-communicator report", SKILLS)).toEqual({
      commandText: "/skill:html-communicator /skill:review . then report",
      skillName: "html-communicator",
    });
  });

  it("dispatches discovered Unicode skill names", () => {
    expect(planPiSkillDispatch("please use $réviser now", SKILLS)).toEqual({
      commandText: "/skill:réviser please use now",
      skillName: "réviser",
    });
  });

  it("dispatches discovered skill names that begin with digits", () => {
    expect(planPiSkillDispatch("please use $123-review now", SKILLS)).toEqual({
      commandText: "/skill:123-review please use now",
      skillName: "123-review",
    });
  });

  it.each([":", "-", "_"])(
    "trims terminal %s punctuation when it is not a skill name",
    (suffix) => {
      expect(planPiSkillDispatch(`$review${suffix} now`, new Set(["review"]))).toEqual({
        commandText: `/skill:review ${suffix} now`,
        skillName: "review",
      });
    },
  );

  it("keeps discovered names that end in punctuation-like characters", () => {
    expect(planPiSkillDispatch("$review_ now", new Set(["review", "review_"]))).toEqual({
      commandText: "/skill:review_ now",
      skillName: "review_",
    });
  });

  it.each(["e\u0301$review", "foo\u203f$review"])(
    "does not treat combining marks or connector punctuation as mention boundaries in %s",
    (prompt) => {
      expect(planPiSkillDispatch(prompt, SKILLS)).toBeUndefined();
    },
  );
});
