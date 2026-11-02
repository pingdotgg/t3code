import { describe, expect, it } from "vite-plus/test";

import { AXES, DEVICE_CLASSES } from "./cases.ts";
import { fillTemplate } from "./pack.ts";
import { median, parseReviewerReply, renderSummary, summarizeRound } from "./scores.ts";

const uniform = (value: number) =>
  Object.fromEntries(
    DEVICE_CLASSES.map((device) => [
      device.id,
      Object.fromEntries(AXES.map((axis) => [axis.id, value])),
    ]),
  );

const reply = (value: number, fixes = ["Give the question panel the space above the composer."]) =>
  `Prose first.\n\n\`\`\`json\n{"example": true}\n\`\`\`\n\nFinal:\n\n\`\`\`json\n${JSON.stringify({ scores: uniform(value), fixes })}\n\`\`\`\n`;

describe("parseReviewerReply", () => {
  it("reads the last json block", () => {
    expect(parseReviewerReply(reply(7)).scores.duo?.polish).toBe(7);
  });

  it("rejects a device scored on only some axes", () => {
    const partial = JSON.stringify({ scores: { iphone: { visual: 7 } }, fixes: ["x"] });
    expect(() => parseReviewerReply(`\`\`\`json\n${partial}\n\`\`\``)).toThrow();
  });

  it("rejects scores outside 1 to 10", () => {
    expect(() => parseReviewerReply(reply(11))).toThrow();
  });
});

describe("summarizeRound", () => {
  it("takes the median per device and axis", () => {
    expect(median([9, 6, 7])).toBe(7);
    expect(median([6, 9])).toBe(7.5);
    const round = summarizeRound({
      opus: parseReviewerReply(reply(6)),
      sol: parseReviewerReply(reply(9)),
    });
    expect(round.medians.ipad?.visual).toBe(7.5);
  });

  it("leaves out devices nobody scored", () => {
    const iphoneOnly = JSON.stringify({ scores: { iphone: uniform(7).iphone }, fixes: ["x"] });
    const round = summarizeRound({
      opus: parseReviewerReply(`\`\`\`json\n${iphoneOnly}\n\`\`\``),
    });
    expect(round.medians.iphone?.polish).toBe(7);
    expect(round.medians.duo).toBeUndefined();
    expect(renderSummary(round, null)).not.toContain("iPhone Duo");
  });

  it("shows deltas against the baseline medians", () => {
    const baseline = summarizeRound({ opus: parseReviewerReply(reply(6)) });
    const markdown = renderSummary(
      summarizeRound({ opus: parseReviewerReply(reply(8)) }),
      baseline,
    );
    expect(markdown).toContain("| iPhone 17 Pro | Visual design | 8.0 | 8.0 | +2.0 |");
    expect(markdown).not.toContain("baseline panel");
  });

  it("flags a baseline scored by a different panel", () => {
    const baseline = summarizeRound({ opus: parseReviewerReply(reply(6)) });
    const round = summarizeRound({
      opus: parseReviewerReply(reply(8)),
      muse: parseReviewerReply(reply(8)),
    });
    expect(renderSummary(round, baseline)).toContain("The baseline panel was opus");
  });
});

describe("fillTemplate", () => {
  it("inserts values literally, even replacement patterns from a stopped flow", () => {
    const flows = "stopped: timed out waiting for '^Plan offline mode$' (saw: Chats)";
    expect(fillTemplate("{{FLOWS}}\n{{AXES}}", { FLOWS: flows, AXES: "axes" })).toBe(
      `${flows}\naxes`,
    );
  });
});
