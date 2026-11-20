import { Code, Workflow } from "lucide-react";
import { type ReactNode, Suspense, useState } from "react";

import { Tooltip } from "../ui/Tooltip";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import { MermaidDiagram } from "./MermaidDiagram";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

/**
 * A Mermaid fence, drawn as a diagram once its closing line arrives, with a toggle to its source. A
 * diagram that fails to load or parse falls back to the source.
 */
export function MermaidBlock({
  code,
  title,
  streaming,
  children,
}: {
  code: string;
  title: string | null;
  streaming: boolean;
  /** The block's source as a colored code block, shown while it streams and when the diagram fails. */
  children: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  const showDiagram = !showCode && !streaming && code.trim().length > 0;
  if (!showDiagram) {
    return (
      <CodeBlock
        code={code}
        language="mermaid"
        title={title}
        streaming={streaming}
        toolbar={
          streaming ? null : (
            <Tooltip text="Show diagram" align="end">
              <button
                type="button"
                aria-label="Show diagram"
                onClick={() => setShowCode(false)}
                className="grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
              >
                <Workflow className="size-3.5" aria-hidden />
              </button>
            </Tooltip>
          )
        }
      >
        {children}
      </CodeBlock>
    );
  }
  return (
    <div className="my-2.5" data-language="mermaid">
      <div className="flex items-center justify-end gap-0.5 pt-1.5 pr-1.5 select-none">
        <Tooltip text="Show code" align="end">
          <button
            type="button"
            aria-label="Show code"
            onClick={() => setShowCode(true)}
            className="grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
          >
            <Code className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
        <CopyButton read={() => code} label="Copy code" />
      </div>
      <RenderErrorBoundary resetKeys={[code]} fallback={children}>
        <Suspense
          fallback={
            <pre className="invisible" aria-hidden>
              {code}
            </pre>
          }
        >
          <MermaidDiagram source={code} />
        </Suspense>
      </RenderErrorBoundary>
    </div>
  );
}
