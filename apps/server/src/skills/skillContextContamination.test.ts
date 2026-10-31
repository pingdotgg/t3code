import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  SkillTurnResolution,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  contaminatingSkillContexts,
  turnItemCarriesOmittedSkillContext,
} from "./skillContextContamination.ts";

const oldVariantPath = "/state/skill-variants/old-hash/SKILL.md";
const now = DateTime.makeUnsafe("2026-10-29T00:00:00.000Z");
const itemBase = {
  threadId: ThreadId.make("thread:skill-context"),
  runId: RunId.make("run:skill-context"),
  nodeId: NodeId.make("node:skill-context"),
  providerThreadId: ProviderThreadId.make("provider-thread:skill-context"),
  providerTurnId: ProviderTurnId.make("provider-turn:skill-context"),
  nativeItemRef: null,
  parentItemId: null,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};

it("marks disabled and changed activated policies as contaminating", () => {
  const omissions = contaminatingSkillContexts({
    activated: [
      {
        skillName: "Review",
        mode: "variant",
        contentHash: "old-hash",
        variantPath: oldVariantPath,
        skillPath: "/home/user/.claude/skills/review/SKILL.md",
      },
      {
        skillName: "docs",
        mode: "base",
        contentHash: null,
        variantPath: null,
        skillPath: "/home/user/.claude/skills/docs/SKILL.md",
      },
    ],
    targetResolution: SkillTurnResolution.make({
      entries: [
        {
          skillName: "review",
          ruleId: "rule:off",
          revision: 1,
          mode: "off",
          contentHash: null,
          variantPath: null,
          origin: "rule",
        },
        {
          skillName: "docs",
          ruleId: "rule:docs",
          revision: 1,
          mode: "variant",
          contentHash: "docs-hash",
          variantPath: "/state/skill-variants/docs-hash/SKILL.md",
          origin: "rule",
        },
      ],
      hash: "target-hash",
    }),
  });

  assert.deepEqual(omissions, [
    {
      skillName: "docs",
      variantPaths: [],
      skillPaths: ["/home/user/.claude/skills/docs/SKILL.md"],
    },
    {
      skillName: "review",
      variantPaths: [oldVariantPath],
      skillPaths: ["/home/user/.claude/skills/review/SKILL.md"],
    },
  ]);
});

it("keeps base and identical variants in the same native context", () => {
  const omissions = contaminatingSkillContexts({
    activated: [
      {
        skillName: "review",
        mode: "variant",
        contentHash: "same-hash",
        variantPath: "/state/skill-variants/same-hash/SKILL.md",
        skillPath: "/home/user/.claude/skills/review/SKILL.md",
      },
      {
        skillName: "docs",
        mode: "base",
        contentHash: null,
        variantPath: null,
        skillPath: "/home/user/.claude/skills/docs/SKILL.md",
      },
    ],
    targetResolution: SkillTurnResolution.make({
      entries: [
        {
          skillName: "review",
          ruleId: "rule:review",
          revision: 2,
          mode: "variant",
          contentHash: "same-hash",
          variantPath: "/different-root/same-hash/SKILL.md",
          origin: "rule",
        },
      ],
      hash: "target-hash",
    }),
  });

  assert.deepEqual(omissions, []);
});

it("recognizes native activation and skill path items without filtering assistant prose", () => {
  const omissions = [
    {
      skillName: "review",
      variantPaths: [oldVariantPath],
      skillPaths: ["/home/user/.claude/skills/review/SKILL.md"],
    },
  ];
  const items: OrchestrationV2TurnItem[] = [
    {
      ...itemBase,
      id: TurnItemId.make("item:skill"),
      ordinal: 1,
      type: "dynamic_tool",
      toolName: "Skill",
      input: { skill: "review" },
    },
    {
      ...itemBase,
      id: TurnItemId.make("item:read"),
      ordinal: 2,
      type: "command_execution",
      input: `read ${oldVariantPath}`,
      exitCode: 0,
    },
    {
      ...itemBase,
      id: TurnItemId.make("item:resource"),
      ordinal: 3,
      type: "command_execution",
      input: "node /home/user/.claude/skills/review/scripts/check.mjs",
      exitCode: 0,
    },
    {
      ...itemBase,
      id: TurnItemId.make("item:unrelated-review-path"),
      ordinal: 4,
      type: "command_execution",
      input: "cat /repo/review/notes.md",
      exitCode: 0,
    },
    {
      ...itemBase,
      id: TurnItemId.make("item:assistant"),
      ordinal: 5,
      type: "assistant_message",
      messageId: MessageId.make("message:assistant"),
      text: `I used review from ${oldVariantPath}.`,
      streaming: false,
    },
    {
      ...itemBase,
      id: TurnItemId.make("item:plugin-skill"),
      ordinal: 6,
      type: "dynamic_tool",
      toolName: "Skill",
      input: { skill: "plugin:review" },
    },
    {
      ...itemBase,
      id: TurnItemId.make("item:variant-skill"),
      ordinal: 7,
      type: "dynamic_tool",
      toolName: "Skill",
      input: { skill: "t3-variants:review-t3-variant" },
    },
    {
      ...itemBase,
      id: TurnItemId.make("item:other-qualified-skill"),
      ordinal: 8,
      type: "dynamic_tool",
      toolName: "Skill",
      input: { skill: "other:review" },
    },
    {
      ...itemBase,
      id: TurnItemId.make("item:nested-skill"),
      ordinal: 9,
      type: "dynamic_tool",
      toolName: "Skill",
      input: { skill: "other", metadata: { skill: "review" } },
    },
  ];

  assert.deepEqual(
    items.map((item) => turnItemCarriesOmittedSkillContext(item, omissions)),
    [true, true, true, false, false, true, true, false, false],
  );
});
