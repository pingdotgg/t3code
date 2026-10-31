import { defineConfig, type CodeRabbitContext } from "@coderabbitai/config";

const UNGATED_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const isGated = ({ pr }: CodeRabbitContext) => !UNGATED_AUTHORS.has(pr?.authorAssociation ?? "");

export default defineConfig((ctx) => ({
  reviews: {
    high_level_summary: false,
    review_status: false,
    request_changes_workflow: false,
    allow_author_approval: !isGated(ctx),
    auto_review: {
      enabled: true,
    },
    pre_merge_checks: {
      docstrings: { mode: "off" },
      override_requested_reviewers_only: isGated(ctx),
    },
    path_filters: ["!.repos/**"],
    path_instructions: [
      {
        path: "{apps,packages,infra}/**/*.ts",
        instructions: "Hold changed code to the rules in docs/internals/effect-services.md.",
      },
      {
        path: "apps/web/src/**/*.{tsx,css}",
        instructions: "Hold changed code to the rules in docs/internals/web-ui.md.",
      },
      {
        path: "**/*.test.*",
        instructions:
          "Hold changed tests to the rules in docs/internals/testing.md. Request tests only as those rules allow.",
      },
    ],
  },
  knowledge_base: {
    code_guidelines: {
      filePatterns: [
        { files: "docs/internals/effect-services.md", applyTo: "{apps,packages,infra}/**/*.ts" },
        { files: "docs/internals/web-ui.md", applyTo: "apps/web/src/**/*.{tsx,css}" },
        { files: "docs/internals/testing.md", applyTo: "{apps,packages,infra}/**/*.{ts,tsx}" },
      ],
    },
  },
}));
