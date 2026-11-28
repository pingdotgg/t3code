import { useGT } from "gt-react";
import { CodeIcon, WorkflowIcon } from "lucide-react";
import { Suspense, use, useState, type ReactNode } from "react";

import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { findRevealRef, MarkdownFindContext } from "./markdownFindContext";
import { MermaidDiagram } from "./MermaidDiagram";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function MarkdownMermaidCodeBlock({
  code,
  fenceTitle,
  theme,
  isStreaming,
  onExpand,
  children,
}: {
  code: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  isStreaming: boolean;
  onExpand: (imageUrl: string) => void;
  children: ReactNode;
}) {
  const gt = useGT();
  const [showCode, setShowCode] = useState(false);
  const searching = use(MarkdownFindContext);
  const revealSource = () => setShowCode(true);
  const sourceRevealRef = findRevealRef(revealSource);
  const showDiagram = !showCode && !isStreaming && code.trim().length > 0;
  const toggleLabel = showCode ? gt("Show diagram") : gt("Show code");
  return (
    <MarkdownCodeBlock
      code={code}
      language="mermaid"
      fenceTitle={fenceTitle}
      theme={theme}
      isStreaming={isStreaming}
      canWrap={!showDiagram}
      diagram={showDiagram}
      viewToggle={
        isStreaming ? null : (
          <SharedTooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                onClick={() => setShowCode((value) => !value)}
                aria-label={toggleLabel}
              />
            }
            label={toggleLabel}
          >
            {showCode ? <WorkflowIcon className="size-3" /> : <CodeIcon className="size-3" />}
          </SharedTooltipTrigger>
        )
      }
    >
      {showDiagram ? (
        <RenderErrorBoundary resetKeys={[code, theme]} fallback={children}>
          <Suspense
            fallback={
              <pre className="invisible" aria-hidden>
                {code}
              </pre>
            }
          >
            <MermaidDiagram source={code} onExpand={onExpand} />
          </Suspense>
          {searching ? (
            <pre ref={sourceRevealRef} hidden aria-hidden>
              {code}
            </pre>
          ) : null}
        </RenderErrorBoundary>
      ) : (
        children
      )}
    </MarkdownCodeBlock>
  );
}
