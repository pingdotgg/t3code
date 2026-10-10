import { ProviderDriverKind, ProviderThreadId, RunId, ThreadId } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  collectLinkedSkillMentions,
  expandLinkedSkillMentions,
  findUnavailableSkillMention,
  UnavailableSkillMentionError,
} from "./linkedSkillMentions.ts";

const projectReview = "/repo/.claude/skills/review/SKILL.md";
const userReview = "/home/me/.claude/skills/review/SKILL.md";
const expand = (text: string) => expandLinkedSkillMentions(text, collectLinkedSkillMentions(text));

describe("collectLinkedSkillMentions", () => {
  it("skips links inside code spans and fences, which are literal text", () => {
    const text = [
      `Run [$review](${projectReview}) now, not \`[$review](${userReview})\`.`,
      "```",
      `[$review](${userReview}) `,
      "```",
      `~~~~md`,
      `[$review](${userReview}) `,
    ].join("\n");
    expect(collectLinkedSkillMentions(text).map((mention) => mention.path)).toEqual([
      projectReview,
    ]);
  });
});

describe("findUnavailableSkillMention", () => {
  const mentions = collectLinkedSkillMentions(`Run [$review](${projectReview}) now`);

  it("accepts a link to an enabled skill the provider reported", () => {
    expect(
      findUnavailableSkillMention(mentions, [
        { name: "review", path: userReview, enabled: true },
        { name: "review", path: projectReview, enabled: true },
      ]),
    ).toBeUndefined();
  });

  it.each([
    ["is missing", [{ name: "review", path: userReview, enabled: true }]],
    ["is disabled", [{ name: "review", path: projectReview, enabled: false }]],
    [
      "is reserved for the agent",
      [{ name: "review", path: projectReview, enabled: true, userInvocable: false }],
    ],
    ["has another name", [{ name: "lint", path: projectReview, enabled: true }]],
  ])("rejects a link whose skill %s", (_case, skills) => {
    expect(findUnavailableSkillMention(mentions, skills)?.path).toBe(projectReview);
  });
});

describe("expandLinkedSkillMentions", () => {
  it("replaces a linked mention with the name and points at the picked file", () => {
    expect(expand(`Run [$review](${projectReview}) on this diff`)).toBe(
      `Run review on this diff\n\nThe user invoked the \`review\` skill defined in ${projectReview}. Read that file and follow its instructions, not those of any other skill named \`review\`.`,
    );
  });

  it("names each picked file once, including a mention that ends the prompt", () => {
    const expanded = expand(`[$review](${projectReview}) first, then [$review](${projectReview})`);
    expect(expanded.startsWith("review first, then review\n\n")).toBe(true);
    expect(expanded.split(projectReview)).toHaveLength(2);
  });

  it("leaves plain mentions for the provider's native dispatch", () => {
    expect(expand("Run $review on this diff")).toBe("Run $review on this diff");
  });
});

describe("UnavailableSkillMentionError", () => {
  it("tells the user which picked skill the provider no longer has", () => {
    const unavailable = new UnavailableSkillMentionError({ name: "review", path: projectReview });
    const cause = new ProviderAdapterTurnStartError({
      driver: ProviderDriverKind.make("claudeAgent"),
      threadId: ThreadId.make("thread:skill-error"),
      providerThreadId: ProviderThreadId.make("provider-thread:skill-error"),
      runId: RunId.make("run:skill-error"),
      cause: unavailable,
    });
    expect(makeProviderFailure({ cause: Cause.fail(cause) }).message).toBe(unavailable.message);
  });
});
