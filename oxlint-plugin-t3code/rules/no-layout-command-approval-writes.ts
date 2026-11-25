import { defineRule } from "@oxlint/plugins";

const WRITES_MODULE =
  /(?:^|\/)(?:LayoutCommandApprovalWrites|ClaudeProjectHookApprovalWrites)(?:\.ts)?$/u;

const message =
  "Only the client RPC a person's session calls records an approval of a project's own commands: its worktree layout commands and its Claude Code hooks (ws.ts). Nothing an agent can reach may import LayoutCommandApprovalWrites or ClaudeProjectHookApprovalWrites: read approvals through LayoutCommandApprovals or ClaudeProjectHooks instead.";

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
        "Keep the modules that record approvals of a project's own commands out of everything but the client RPC.",
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
