import { defineRule } from "@oxlint/plugins";

const WRITES_MODULE = /(?:^|\/)(?:LayoutCommandApprovalWrites|ClaudeProjectTrustWrites)(?:\.ts)?$/u;

const message =
  "Only the client RPC a person's session calls records that a person lets a project's own commands run: its worktree layout commands and its Claude Code settings (ws.ts). Nothing an agent can reach may import LayoutCommandApprovalWrites or ClaudeProjectTrustWrites: read through LayoutCommandApprovals or ClaudeProjectTrust instead.";

const importsWrites = (source: unknown) =>
  typeof source === "object" &&
  source !== null &&
  "value" in source &&
  typeof source.value === "string" &&
  WRITES_MODULE.test(source.value);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the modules that record a person's approval or trust of a project's own commands out of everything but the client RPC.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (importsWrites(node.source)) context.report({ node, message });
      },
      ExportNamedDeclaration(node) {
        if (importsWrites(node.source)) context.report({ node, message });
      },
      ExportAllDeclaration(node) {
        if (importsWrites(node.source)) context.report({ node, message });
      },
      ImportExpression(node) {
        if (importsWrites(node.source)) context.report({ node, message });
      },
    };
  },
});
