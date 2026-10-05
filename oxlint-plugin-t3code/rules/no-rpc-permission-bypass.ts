import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";
import { getPropertyName } from "../utils.ts";

/** A guardrail for ordinary edits, not a security boundary against deliberate casts or aliases. */
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep raw RPC access and permission guard installation inside their shared boundaries.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(filename)) return {};
    const rpc = filename.includes("/packages/client-runtime/src/rpc/");
    const guardOwner =
      rpc || /\/packages\/client-runtime\/src\/state\/(runtime|vcsAction)\.ts$/.test(filename);
    const state = filename.includes("/packages/client-runtime/src/state/");
    const report = (node: Parameters<typeof context.report>[0]["node"]) =>
      context.report({
        node,
        message:
          "Use permission-aware environment commands. Raw RPC access and RpcPermissionGuard belong in the shared RPC/command boundary.",
      });
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== "string") return;
        const source = node.source.value;
        if (!rpc && /(?:^|\/)rpc\/protocol(?:\.ts)?$/.test(source) && node.importKind !== "type")
          report(node);
        if (!guardOwner && /(?:^|\/)rpc\/client(?:\.ts)?$/.test(source)) {
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              Option.getOrNull(getPropertyName(specifier.imported)) === "RpcPermissionGuard"
            )
              report(specifier);
          }
        }
      },
      MemberExpression(node) {
        const property = Option.getOrNull(getPropertyName(node.property));
        if (!guardOwner && property === "RpcPermissionGuard") report(node);
        // State code only needs the typed request/stream helpers. Relay HTTP clients also
        // have a .client member, so this deliberately does not ban that name globally.
        if (state && property === "client") report(node);
      },
    };
  },
});
