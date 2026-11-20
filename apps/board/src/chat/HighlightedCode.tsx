import type { Root } from "hast";
import { toHtml } from "hast-util-to-html";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import {
  cloneElement,
  type DOMAttributes,
  isValidElement,
  memo,
  use,
  useCallback,
  useMemo,
} from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import {
  CODE_THEME,
  createIncrementalHighlight,
  highlighterFor,
  highlightToHast,
  rememberHighlight,
} from "./highlight";

const runtime = { Fragment, jsx, jsxs };

type HighlightedElement = Extract<Root["children"][number], { type: "element" }>;

function shell(node: HighlightedElement) {
  const element = toJsxRuntime({ ...node, children: [] }, runtime);
  if (!isValidElement<DOMAttributes<HTMLElement>>(element)) {
    throw new Error("Expected a highlighted code element");
  }
  return element;
}

const HighlightedLine = memo(function HighlightedLine({
  node,
}: {
  node: Root["children"][number];
}) {
  if (node.type !== "element") return toJsxRuntime(node, runtime);
  return cloneElement(shell(node), {
    dangerouslySetInnerHTML: { __html: toHtml({ type: "root", children: node.children }) },
  });
});

/** Keeps a finished line's DOM across renders, so a block that grows does not reparse its early lines. */
function highlightedLines(root: Root) {
  const pre = root.children[0];
  if (pre?.type !== "element" || pre.tagName !== "pre") return toJsxRuntime(root, runtime);
  const code = pre.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return toJsxRuntime(root, runtime);
  return cloneElement(
    shell(pre),
    undefined,
    cloneElement(
      shell(code),
      undefined,
      code.children.map((node, index) => (
        // Appending keeps every line's position.
        // oxlint-disable-next-line react/no-array-index-key
        <HighlightedLine key={index} node={node} />
      )),
    ),
  );
}

/** The code as plain text, which stands in until the highlighter loads and when it fails. */
export function plainCode(code: string) {
  return (
    <div className="board-code">
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Code colored with T3's Shiki theme. A block that streams tokenizes only the text that arrived. */
export function HighlightedCode({
  code,
  language,
  streaming,
  cacheKey,
  preserveLines,
}: {
  code: string;
  language: string;
  streaming: boolean;
  cacheKey: string;
  preserveLines: boolean;
}) {
  const highlighter = use(highlighterFor(language));
  const incremental = useMemo(
    () => (preserveLines ? createIncrementalHighlight(highlighter, language, CODE_THEME) : null),
    [highlighter, language, preserveLines],
  );
  // Frees the tokenizer when the block unmounts or its highlighter is replaced.
  const release = useCallback(() => () => incremental?.dispose(), [incremental]);

  let root: Root;
  try {
    root = incremental
      ? incremental(code)
      : highlightToHast(highlighter, code, language, CODE_THEME);
  } catch (error) {
    console.warn(`Highlighting failed for "${language}"; showing plain text.`, error);
    return plainCode(code);
  }
  if (!streaming) rememberHighlight(cacheKey, toHtml(root));
  return (
    <div ref={release} className="board-code">
      {highlightedLines(root)}
    </div>
  );
}
