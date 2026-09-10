import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import React, {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error) => ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class MermaidErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.warn("Mermaid rendering crashed:", error, errorInfo);
  }

  override render() {
    if (this.state.hasError && this.state.error) {
      if (this.fallback) {
        return this.fallback(this.state.error);
      }
      return (
        <div className="m-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>Mermaid Render Error</span>
          </div>
          <div className="whitespace-pre-wrap font-mono text-[11px]">
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }

  private get fallback() {
    return this.props.fallback;
  }
}

export interface MermaidDiagramProps {
  code: string;
  theme: "light" | "dark";
  isStreaming?: boolean;
}

let mermaidCounter = 0;

export function MermaidDiagram({ code, theme, isStreaming = false }: MermaidDiagramProps) {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const renderId = `mermaid-render-${Date.now()}-${++mermaidCounter}`;

    async function renderMermaid() {
      setIsLoading(true);
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;

        mermaid.initialize({
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
          securityLevel: "loose",
          fontFamily: "var(--font-sans, inherit)",
          logLevel: "error",
        });

        const { svg, bindFunctions } = await mermaid.render(renderId, code);

        if (!cancelled) {
          setSvgHtml(svg);
          setError(null);
          setIsLoading(false);

          // Allow DOM to update before binding interactions
          requestAnimationFrame(() => {
            if (containerRef.current && bindFunctions) {
              try {
                bindFunctions(containerRef.current);
              } catch {
                // Binding functions might fail if element not mounted; safe to ignore
              }
            }
          });
        }
      } catch (err: unknown) {
        if (!cancelled) {
          // Clean up any stray mermaid elements inserted into DOM during failed render
          if (typeof document !== "undefined") {
            const strayEl =
              document.getElementById(renderId) || document.getElementById(`d${renderId}`);
            if (strayEl) {
              strayEl.remove();
            }
          }

          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setIsLoading(false);
        }
      }
    }

    void renderMermaid();

    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  if (typeof document === "undefined") {
    return (
      <div className="flex w-full items-center justify-center p-4 text-xs text-muted-foreground">
        <span>Mermaid diagram</span>
      </div>
    );
  }

  if (error) {
    if (isStreaming) {
      return (
        <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span>Generating diagram...</span>
        </div>
      );
    }
    return (
      <div className="m-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          <AlertCircleIcon className="size-4 shrink-0" />
          <span>Mermaid Syntax Error</span>
        </div>
        <div className="whitespace-pre-wrap font-mono text-[11px]">{error}</div>
      </div>
    );
  }

  if (isLoading && !svgHtml) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        <span>Rendering diagram...</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="chat-markdown-mermaid-container flex w-full items-center justify-center overflow-x-auto bg-card/40 p-4 [&>svg]:h-auto [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svgHtml ?? "" }}
    />
  );
}
