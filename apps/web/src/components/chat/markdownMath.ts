import type { PluggableList } from "unified";
import rehypeKatex from "rehype-katex";
import { remarkChatMath } from "@t3tools/shared/markdownMath";
import { CHAT_MARKDOWN_REHYPE_PLUGINS } from "@t3tools/shared/markdownPipeline";

type Root = Parameters<ReturnType<typeof rehypeKatex>>[0];
type RootContent = Root["children"][number];
type Element = Extract<RootContent, { type: "element" }>;

const MAX_CACHED_EXPRESSIONS = 64;
const expressionCache = new Map<string, RootContent[]>();
type MathOutput = "htmlAndMathml" | "mathml";

function rehypeCachedKatex({ output }: { output: MathOutput }): ReturnType<typeof rehypeKatex> {
  const render = rehypeKatex({ trust: false, output });
  return (tree, file) => {
    visit(tree);

    function visit(parent: Root | Element) {
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index];
        if (child?.type !== "element") continue;
        const code = child.tagName === "pre" ? child.children[0] : child;
        const classes = code?.type === "element" ? code.properties.className : undefined;
        if (
          code?.type !== "element" ||
          code.tagName !== "code" ||
          !Array.isArray(classes) ||
          !classes.some((name) => ["math-inline", "math-display"].includes(String(name)))
        ) {
          visit(child);
          continue;
        }
        const value = code.children
          .map((node) => (node.type === "text" ? node.value : ""))
          .join("");
        const display = child.tagName === "pre" || classes.includes("math-display");
        const key = `${output}\0${display}\0${value}`;
        let result = expressionCache.get(key);
        if (!result) {
          const fragment: Root = { type: "root", children: [child] };
          render(fragment, file);
          result = fragment.children;
          expressionCache.set(key, structuredClone(result));
          if (expressionCache.size > MAX_CACHED_EXPRESSIONS) {
            expressionCache.delete(expressionCache.keys().next().value!);
          }
        } else {
          // Each processor owns mutable nodes; never hand it the cached tree.
          result = structuredClone(result);
        }
        parent.children.splice(index, 1, ...(result as Element["children"]));
        index += result.length - 1;
      }
    }
  };
}

export function createChatMathPlugins(output: MathOutput = "htmlAndMathml") {
  const katexPlugins: PluggableList = [[rehypeCachedKatex, { output }]];
  return {
    remark: [remarkChatMath] satisfies PluggableList,
    // Sanitize authored HTML before KaTeX generates its own MathML and styles.
    rehype: [...CHAT_MARKDOWN_REHYPE_PLUGINS, ...katexPlugins],
    literalRehype: katexPlugins,
  };
}

export const CHAT_MATH_PLUGINS = createChatMathPlugins();
