import { mathKind } from "@t3tools/shared/markdownMath";
import { use } from "react";
import type { Components } from "react-markdown";

import { BlockContext } from "./blockContext";
import { CodeBlock } from "./CodeBlock";
import { CodeBody } from "./CodeBody";
import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
} from "./fences";
import { MathBlock } from "./MathBlock";
import { MermaidBlock } from "./MermaidBlock";

/** A fenced block: code with its copy button, a Mermaid diagram, or a display formula. */
export const MarkdownPre: NonNullable<Components["pre"]> = function Pre({
  node,
  children,
  ...props
}) {
  const { text, streaming } = use(BlockContext);
  const block = extractCodeBlock(children);
  if (block === null) return <pre {...props}>{children}</pre>;
  const language = extractFenceLanguage(block.className);
  const closed = isClosedCodeFence(node, text, block.code);
  if (language === "math" && (!streaming || mathKind(block.className) === "display" || closed)) {
    return <MathBlock tex={block.code} display />;
  }
  const title = extractFenceTitle(extractPreCodeMeta(node));
  if (language === "mermaid") {
    return (
      <MermaidBlock code={block.code} title={title} streaming={streaming && !closed}>
        <CodeBody code={block.code} language={language} streaming={streaming} />
      </MermaidBlock>
    );
  }
  return <CodeBlock code={block.code} language={language} title={title} streaming={streaming} />;
};
