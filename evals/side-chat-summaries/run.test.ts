import { assert, it } from "@effect/vitest";
import { gradeSummary, parseYesNo } from "./run.ts";
import { sideChatSummaryCases } from "./cases.ts";

it("grades length and complete sentence endings", () => {
  const checks = gradeSummary(sideChatSummaryCases[1], `${"x".repeat(1_799)}.`, true);
  assert.isTrue(checks[0]!.pass);
  assert.isTrue(checks[1]!.pass);
  assert.isFalse(gradeSummary(sideChatSummaryCases[1], `${"x".repeat(1_800)}.`, true)[0]!.pass);
  assert.isFalse(gradeSummary(sideChatSummaryCases[1], "An unfinished summary", true)[1]!.pass);
});

it("parses a judge's yes or no answer", () => {
  assert.strictEqual(parseYesNo("YES"), true);
  assert.strictEqual(parseYesNo("answer: YES"), true);
  assert.strictEqual(parseYesNo("The answer is NO"), false);
  assert.strictEqual(parseYesNo("**NO**\n"), false);
  assert.strictEqual(parseYesNo("Maybe"), null);
  assert.strictEqual(parseYesNo("YESTERDAY"), null);
});

it("requires the learner confusion judge for the long case", () => {
  const fixture = sideChatSummaryCases[0];
  assert.isTrue(
    gradeSummary(
      fixture,
      "The learner is confused about retaining the first user message. The lesson continues.",
      true,
    ).every((check) => check.pass),
  );
  assert.isFalse(
    gradeSummary(
      fixture,
      "The lesson teaches context management. The learner is confused later.",
      false,
    ).at(-1)!.pass,
  );
  assert.isFalse(
    gradeSummary(fixture, "The learner is confused. The lesson continues.", null).at(-1)!.pass,
  );
});
