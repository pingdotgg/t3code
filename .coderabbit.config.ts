import { defineConfig, type CodeRabbitContext } from "@coderabbitai/config";

const UNGATED_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const isGated = ({ pr }: CodeRabbitContext) => !UNGATED_AUTHORS.has(pr?.authorAssociation ?? "");

const DOC_RULES = [
  {
    files: "docs/internals/effect-services.md",
    applyTo: "{apps,packages,infra}/**/*.ts",
    instructions: "Hold changed code to the rules in docs/internals/effect-services.md.",
  },
  {
    files: "docs/internals/scripts.md",
    applyTo: "{scripts,apps/*/scripts,packages/*/scripts,infra/*/scripts}/**/*.{ts,mts}",
    instructions:
      "Hold repository and package scripts to docs/internals/scripts.md: use Effect, effect/cli, NodeServices, and NodeRuntime.runMain rather than raw node:fs, node:child_process, or hand-rolled process.argv parsing.",
  },
  {
    files: "docs/internals/web-ui.md",
    applyTo: "apps/web/src/**/*.{tsx,css}",
    instructions: "Hold changed code to the rules in docs/internals/web-ui.md.",
  },
  {
    files: "docs/internals/testing.md",
    applyTo: "{apps,packages,infra}/**/*.{ts,tsx}",
    path: "**/*.test.*",
    instructions:
      "Hold changed tests to the rules in docs/internals/testing.md. Request tests only as those rules allow.",
  },
  {
    files: "docs/internals/i18n.md",
    applyTo:
      "{apps/web/src,apps/mobile/src,apps/desktop/src,packages/client-runtime/src,packages/shared/src}/**/*.{ts,tsx}",
    instructions: "Hold user-facing copy and translations to the rules in docs/internals/i18n.md.",
  },
  {
    files: "docs/internals/overview.md",
    applyTo:
      "{apps/server/src/orchestration-v2,apps/server/src/checkpointing,packages/contracts/src,apps/desktop/src/snapShot}/**/*.ts",
    instructions:
      "Hold changed code to the architectural boundaries in docs/internals/overview.md.",
  },
  {
    files: "docs/internals/providers.md",
    applyTo:
      "{packages/provider-*,apps/server/src/provider,apps/server/src/orchestration-v2/Adapters}/**/*.{ts,json}",
    instructions:
      "Hold provider changes to docs/internals/providers.md, including strict ACP spec compliance for non-first-party agents and bumping updatedAt on model-manifest.json edits.",
  },
  {
    files: "docs/internals/connection-runtime.md",
    applyTo: "packages/client-runtime/src/**/*.ts",
    instructions:
      "Hold connection, sync, and cache changes to docs/internals/connection-runtime.md.",
  },
  {
    files: "docs/internals/environment-auth.md",
    applyTo:
      "{apps/server/src/auth,apps/server/src/mcp,apps/server/src/guest,apps/server/src/assets,apps/server/src/workspace}/**/*.ts",
    instructions:
      "Hold auth, MCP, guest link, and filesystem boundary changes to docs/internals/environment-auth.md.",
  },
  {
    files: "docs/internals/remote.md",
    applyTo:
      "{apps/server/src/peer,apps/server/src/environment,packages/ssh,packages/tailscale,apps/desktop/src/preview,apps/desktop/src/ssh}/**/*.ts",
    instructions:
      "Hold remote route, peer link, SSH, and preview tunnel changes to docs/internals/remote.md.",
  },
  {
    files: "docs/internals/t3-connect.md",
    applyTo: "{infra/relay/src,apps/server/src/cloud}/**/*.ts",
    instructions: "Hold relay and T3 Connect changes to docs/internals/t3-connect.md.",
  },
  {
    files: "SECURITY.md",
    applyTo:
      "{apps/server/src/auth,apps/server/src/mcp,apps/server/src/guest,apps/server/src/assets,apps/server/src/peer,apps/server/src/cloud,apps/server/src/policy,infra/relay/src}/**/*.ts",
    instructions:
      "Check security boundary changes against the trust model and real-finding criteria in SECURITY.md.",
  },
  {
    files: "docs/internals/server-updates.md",
    applyTo:
      "apps/server/src/{serviceLauncher.ts,desktopUpdate/**,cloud/serviceSelectionLock.ts,orchestration-v2/ProviderRuntimeRecoveryService.ts,orchestration-v2/RestartContinuation.ts}",
    instructions:
      "Hold update, rollback, and restart-recovery changes to docs/internals/server-updates.md.",
  },
  {
    files: "docs/internals/performance-regressions.md",
    applyTo:
      "{apps/server/src/orchestration-v2,apps/server/integration,apps/mobile/src}/**/*.{ts,tsx}",
    instructions:
      "Hold wire payload, indexing, and mobile animation changes to docs/internals/performance-regressions.md.",
  },
  {
    files: "docs/internals/product-analytics.md",
    applyTo: "{apps/server/src/telemetry,apps/server/src/feedback}/**/*.ts",
    instructions:
      "Hold analytics identity, attribution, and privacy boundaries to docs/internals/product-analytics.md.",
  },
  {
    files: "docs/internals/mobile-layout.md",
    applyTo: "apps/mobile/src/**/*.{ts,tsx}",
    instructions: "Hold mobile layout and pane changes to docs/internals/mobile-layout.md.",
  },
  {
    files: "docs/internals/mobile-navigation.md",
    applyTo: "apps/mobile/{src,modules}/**/*.{ts,tsx,swift,kt}",
    instructions:
      "Hold mobile navigation, native header, and media presentation changes to docs/internals/mobile-navigation.md.",
  },
  {
    files: "docs/internals/mobile-development.md",
    applyTo: "apps/mobile/{src/lib,modules,scripts}/**/*.{ts,tsx,mts}",
    instructions:
      "Hold mobile HMR, native module, and React Compiler changes to docs/internals/mobile-development.md.",
  },
  {
    files: "AGENTS.md",
    applyTo: "docs/internals/**/*.md",
    instructions:
      "Hold internal doc edits to the Documentation rules in AGENTS.md: keep only durable architectural decisions, trust boundaries, conventions, and cross-cutting traps. Flag single-feature walkthroughs, field/method catalogs, exact constants/timeouts/migration numbers, and PR appends.",
  },
] as const;

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
    path_instructions: DOC_RULES.map((rule) => ({
      path: "path" in rule ? rule.path : rule.applyTo,
      instructions: rule.instructions,
    })),
  },
  knowledge_base: {
    code_guidelines: {
      filePatterns: DOC_RULES.map(({ files, applyTo }) => ({ files, applyTo })),
    },
  },
}));
