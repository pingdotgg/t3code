import { mathKind } from "@t3tools/shared/markdownMath";
import type { Components } from "react-markdown";

import { ArtifactLink } from "./ArtifactLink";
import { useArtifactMatch } from "./artifactLookup";
import { nodeToPlainText } from "./fences";
import { MathBlock } from "./MathBlock";

/** Inline code, a formula, or a path that names an artifact. */
export const MarkdownCode: NonNullable<Components["code"]> = function Code({
  node,
  children,
  className,
  ...props
}) {
  const written = nodeToPlainText(children).trim();
  const artifact = useArtifactMatch(
    node?.properties["dataInlineCode"] != null && written.includes("/") ? written : null,
  );
  const math = mathKind(className);
  if (math !== null) return <MathBlock tex={written} display={math === "display"} />;
  if (artifact !== null) return <ArtifactLink absolutePath={artifact}>{children}</ArtifactLink>;
  return (
    <code
      className={`rounded bg-hover px-1 py-px font-mono text-[12px] [pre_&]:bg-transparent [pre_&]:p-0 ${className ?? ""}`}
      {...props}
    >
      {children}
    </code>
  );
};
