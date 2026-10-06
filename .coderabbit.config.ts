import { defineConfig, type CodeRabbitContext } from "@coderabbitai/config";

const approvability = `Fail when a maintainer should read this pull request before CodeRabbit approves it, and name the rule and file. Fail if it:

- Changes a product default: a setting's default value, or what users get without opting in. Making a feature do what it already promises is a bug fix, not a default change.
- Adds or broadens a directive that disables or suppresses a lint, type-checker, LSP, or other static-analysis diagnostic, including file-level, line-level, and configuration-level overrides.
- Adds a subsystem or user workflow, or is a large refactor across apps or packages.
- Changes packages/contracts or persisted data in a way that existing clients or stored data might not accept.
- Changes authentication, pairing, credentials, secrets, or remote connection trust.
- Adds or changes an external side effect, such as acting on GitHub, publishing a release, or calling a webhook.
- Adds, upgrades, or patches a dependency.
- Changes CI or release configuration, agent or contributor instructions, or any review tool's configuration, including .github/, AGENTS.md, CONTRIBUTING.md, .agents/, and .coderabbit.config.ts.

Otherwise pass. A focused bug fix, copy or layout fix, revert, or docs-only or test-only change passes unless a rule above applies. If you cannot decide, fail rather than report inconclusive. When failing, say that the pull request needs a maintainer's review.
`;

// Org members and collaborators merge their own pull requests. On anyone else's, CodeRabbit
// requests changes until its comments are resolved and its checks pass, then approves.
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
      custom_checks: [
        {
          name: "Approvability",
          mode: isGated(ctx) ? "error" : "off",
          instructions: approvability,
        },
      ],
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
