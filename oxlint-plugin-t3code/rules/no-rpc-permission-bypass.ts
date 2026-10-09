import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";
import { getPropertyName } from "../utils.ts";

const readOptions = (options: ReadonlyArray<unknown>) => {
  const [first] = options;
  return {
    allowRawClientAccess:
      typeof first === "object" &&
      first !== null &&
      "allowRawClientAccess" in first &&
      first.allowRawClientAccess === true,
    allowGuardInstallation:
      typeof first === "object" &&
      first !== null &&
      "allowGuardInstallation" in first &&
      first.allowGuardInstallation === true,
  };
};

/** A guardrail for ordinary edits, not a security boundary against deliberate casts or aliases. */
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep raw RPC access and permission guard installation inside their shared boundaries.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowRawClientAccess: {
            type: "boolean",
            description: "Permit .client access for non-RPC clients in the configured files.",
          },
          allowGuardInstallation: {
            type: "boolean",
            description: "Permit installing RpcPermissionGuard in a reviewed command boundary.",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowRawClientAccess: false, allowGuardInstallation: false }],
  },
  create(context) {
    const { allowRawClientAccess, allowGuardInstallation } = readOptions(context.options);
    const report = (node: NonNullable<Parameters<typeof context.report>[0]["node"]>) =>
      context.report({
        node,
        message:
          "Use permission-aware environment commands. Raw RPC access and RpcPermissionGuard belong in the shared RPC/command boundary.",
      });
    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== "string") return;
        const source = node.source.value;
        if (/(?:^|\/)rpc\/protocol(?:\.ts)?$/.test(source) && node.importKind !== "type")
          report(node);
        if (
          !allowGuardInstallation &&
          /(?:^|\/)rpc(?:\/(?:client|index)(?:\.ts)?)?$/.test(source)
        ) {
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
        if (allowRawClientAccess || node.id.type !== "ObjectPattern") return;
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
        if (!allowGuardInstallation && property === "RpcPermissionGuard") report(node);
        if (!allowRawClientAccess && property === "client") report(node);
      },
    };
  },
});
