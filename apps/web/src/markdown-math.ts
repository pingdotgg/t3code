import type { Root, RootContent } from "mdast";
import remarkMath from "remark-math";
import type { Plugin } from "unified";

/** Keep currency and skill dollars literal, and render standalone $$...$$ as display math. */
export const remarkChatMath: Plugin<[], Root> = function () {
  remarkMath.call(this);
  const extension = this.data().micromarkExtensions?.at(-1);
  const mathText = extension?.text?.[36];
  if (extension?.text && mathText && !Array.isArray(mathText)) {
    extension.text[36] = {
      ...mathText,
      tokenize(effects, ok, nok) {
        return mathText.tokenize.call(
          this,
          effects,
          (code) => {
            const token = this.events.at(-1)?.[1];
            const source = token ? this.sliceSerialize(token) : "";
            // Reject an ambiguous pair before parsing so a later $x$ still renders.
            if (
              !source.startsWith("$$") &&
              (/\s\$$/.test(source) || (code !== null && code >= 48 && code <= 57))
            ) {
              return nok(code);
            }
            return ok(code);
          },
          nok,
        );
      },
    };
  }
  return (tree, file) => {
    const source = String(file);
    const visit = (node: Root | RootContent) => {
      if (node.type === "paragraph" && node.children.length === 1) {
        const math = node.children[0];
        if (
          math?.type === "inlineMath" &&
          source.slice(math.position?.start.offset, math.position?.end.offset).startsWith("$$")
        ) {
          math.data = {
            ...math.data,
            hProperties: {
              ...math.data?.hProperties,
              className: ["language-math", "math-display"],
            },
          };
        }
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
};
