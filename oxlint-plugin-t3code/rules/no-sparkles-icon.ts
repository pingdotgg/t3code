import { defineRule } from "@oxlint/plugins";

const SPARKLE_NAME = /sparkle/iu;
// SF Symbol (`sparkles`, `sparkles.square.filled.on.square`, `wand.and.sparkles`) and
// Material (`auto_awesome`) names reach native icons as plain strings.
const SPARKLE_SYMBOL_NAME = /^(?:(?:[\w]+\.)*sparkles?(?:\.[\w.]+)?|auto_awesome(?:_\w+)?)$/u;
const TABLER_SOURCE = /^@tabler\/icons(?:-react|-react-native)?(?:\/|$)/u;

const MESSAGE =
  "Sparkles says 'AI', not what the control does. Pick an icon for the action itself, such as Bot for agent work or ShieldCheck for Auto mode.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow sparkles icons; they label a control as AI instead of saying what it does.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (source === "lucide-react" || TABLER_SOURCE.test(source)) {
          if (TABLER_SOURCE.test(source) && SPARKLE_NAME.test(source.split("/").at(-1) ?? "")) {
            context.report({ node: node.source, message: MESSAGE });
            return;
          }
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ImportSpecifier") continue;
            const imported =
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value;
            if (SPARKLE_NAME.test(imported)) context.report({ node: specifier, message: MESSAGE });
          }
        }
      },
      Literal(node) {
        if (typeof node.value !== "string" || !SPARKLE_SYMBOL_NAME.test(node.value)) return;
        if (node.parent.type === "ImportDeclaration") return;
        context.report({ node, message: MESSAGE });
      },
      TemplateElement(node) {
        if (!SPARKLE_SYMBOL_NAME.test(node.value.cooked ?? "")) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
