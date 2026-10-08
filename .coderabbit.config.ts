import { defineConfig, type CodeRabbitContext } from "@coderabbitai/config";

// Org members and collaborators merge their own pull requests. On anyone else's, CodeRabbit
// requests changes until its comments are resolved, then approves.
const UNGATED_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const isGated = ({ pr }: CodeRabbitContext) => !UNGATED_AUTHORS.has(pr?.authorAssociation ?? "");

export default defineConfig((ctx) => ({
  reviews: {
    high_level_summary: false,
    review_status: false,
    request_changes_workflow: isGated(ctx),
    allow_author_approval: !isGated(ctx),
    auto_review: {
      enabled: true,
    },
    pre_merge_checks: {
      docstrings: { mode: "off" },
      override_requested_reviewers_only: isGated(ctx),
    },
    path_filters: [
      // Vendored read-only reference checkouts of upstream Effect and Alchemy
      // (see scripts/lib/reference-repos.ts). Nothing imports from them.
      "!.repos/**",
    ],
    path_instructions: [
      {
        path: "{apps,packages,infra}/**/*.ts",
        instructions: "Hold changed code to the rules in docs/internals/effect-services.md.",
      },
      {
        path: "apps/web/src/**/*.{tsx,css}",
        instructions: "Hold changed code to the rules in docs/internals/web-ui.md.",
      },
    ],
  },
  knowledge_base: {
    code_guidelines: {
      filePatterns: [
        { files: "docs/internals/effect-services.md", applyTo: "{apps,packages,infra}/**/*.ts" },
        { files: "docs/internals/web-ui.md", applyTo: "apps/web/src/**/*.{tsx,css}" },
      ],
    },
  },
}));
