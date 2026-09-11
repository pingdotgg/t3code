import type { DiffsHighlighter } from "@pierre/diffs";
import { toHtml } from "hast-util-to-html";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { cloneElement, isValidElement, memo, type DOMAttributes } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

type HighlightedRoot = ReturnType<DiffsHighlighter["codeToHast"]>;
type HighlightedNode = HighlightedRoot["children"][number];
const runtime = { Fragment, jsx, jsxs };

function elementShell(node: Extract<HighlightedNode, { type: "element" }>) {
  const element = toJsxRuntime({ ...node, children: [] }, runtime);
  if (!isValidElement<DOMAttributes<HTMLElement>>(element)) {
    throw new Error("Expected a highlighted code element");
  }
  return element;
}

const HighlightedLine = memo(function HighlightedLine({ node }: { node: HighlightedNode }) {
  if (node.type !== "element") return toJsxRuntime(node, runtime);
  return cloneElement(elementShell(node), {
    dangerouslySetInnerHTML: { __html: toHtml({ type: "root", children: node.children }) },
  });
});

/** Completed line nodes retain their identity in the incremental highlighter.
 * Keep their DOM mounted too: replacing the entire pre makes the browser parse
 * and resolve styles for thousands of unchanged token spans on each update.
 */
export function HighlightedCodeLines({ root }: { root: HighlightedRoot }) {
  const pre = root.children[0];
  if (pre?.type !== "element" || pre.tagName !== "pre") return toJsxRuntime(root, runtime);
  const code = pre.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return toJsxRuntime(root, runtime);
  return cloneElement(
    elementShell(pre),
    undefined,
    cloneElement(
      elementShell(code),
      undefined,
      code.children.map((node, index) => (
        // A line's position is stable as tokens and new lines are appended.
        // oxlint-disable-next-line react/no-array-index-key
        <HighlightedLine key={index} node={node} />
      )),
    ),
  );
}
