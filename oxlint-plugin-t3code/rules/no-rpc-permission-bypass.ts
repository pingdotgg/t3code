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
    const app = /\/apps\/(web|mobile|desktop)\/src\//.test(filename);
    // These .client values are session display metadata and an Expo update adapter.
    const nonRpcClient =
      filename.endsWith("/apps/web/src/components/settings/ConnectionsSettings.tsx") ||
      filename.endsWith("/apps/mobile/src/features/updates/app-updates.ts");
    const rawClientForbidden = state || (app && !nonRpcClient);
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
        if (!guardOwner && /(?:^|\/)rpc(?:\/(?:client|index)(?:\.ts)?)?$/.test(source)) {
          for (const specifier of node.specifiers) {
            if (
              specifier.type === "ImportSpecifier" &&
              Option.getOrNull(getPropertyName(specifier.imported)) === "RpcPermissionGuard"
            )
              report(specifier);
          }
        }
      },
      VariableDeclarator(node) {
        if (!rawClientForbidden || node.id.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          if (
            property.type === "Property" &&
            Option.getOrNull(getPropertyName(property.key)) === "client"
          )
            report(property);
        }
      },
      MemberExpression(node) {
        const property = Option.getOrNull(getPropertyName(node.property));
        if (!guardOwner && property === "RpcPermissionGuard") report(node);
        if (rawClientForbidden && property === "client") report(node);
      },
    };
  },
});
