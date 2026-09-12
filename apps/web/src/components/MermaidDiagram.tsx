import type { Mermaid } from "mermaid";
import { useEffect, useId, useState, type ReactNode } from "react";

type MermaidAppearance = "light" | "dark";

interface MermaidDiagramProps {
  code: string;
  theme: MermaidAppearance;
  /** The highlighted source shown while Mermaid loads or if rendering fails. */
  fallback: ReactNode;
}

type MermaidRenderState =
  | { kind: "loading" }
  | { kind: "rendered"; svg: string }
  | { kind: "failed" };

let mermaidPromise: Promise<Mermaid> | null = null;
let initializedAppearance: MermaidAppearance | null = null;

/** Loads Mermaid once and keeps its initialized appearance in sync with the current theme. */
async function getMermaid(appearance: MermaidAppearance): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid")
      .then(({ default: mermaid }) => mermaid)
      .catch((cause: unknown) => {
        // Allow a later render attempt after a transient module-load failure.
        mermaidPromise = null;
        throw cause;
      });
  }

  const mermaid = await mermaidPromise;
  if (initializedAppearance !== appearance) {
    mermaid.initialize({
      securityLevel: "strict",
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: appearance === "dark" ? "dark" : "default",
    });
    initializedAppearance = appearance;
  }

  return mermaid;
}

/** Renders a Mermaid diagram off the streaming path, falling back to its source on failure. */
export default function MermaidDiagram({ code, theme, fallback }: MermaidDiagramProps) {
  // Mermaid uses SVG ids globally, and Mermaid cannot use React's colon-separated ids directly.
  const reactId = useId();
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const [state, setState] = useState<MermaidRenderState>({ kind: "loading" });
  const [stateKey, setStateKey] = useState<string | null>(null);
  const currentKey = `${theme}\0${code}`;
  const visibleState: MermaidRenderState = stateKey === currentKey ? state : { kind: "loading" };

  useEffect(() => {
    let cancelled = false;

    getMermaid(theme)
      .then((mermaid) => mermaid.render(renderId, code))
      .then(({ svg }) => {
        if (!cancelled) {
          setState({ kind: "rendered", svg });
          setStateKey(currentKey);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ kind: "failed" });
          setStateKey(currentKey);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, theme]);

  if (visibleState.kind === "loading") {
    return <>{fallback}</>;
  }

  if (visibleState.kind === "failed") {
    return (
      <div>
        <div
          className="flex items-center gap-1 border-b border-border/60 px-3 pb-1.5 text-xs text-warning"
          data-mermaid-error=""
          role="status"
        >
          Could not render diagram
        </div>
        {fallback}
      </div>
    );
  }

  return (
    <div
      className="flex max-w-full justify-center overflow-x-auto py-2 [&>svg]:h-auto [&>svg]:max-w-none"
      data-mermaid-diagram=""
      // Mermaid already sanitizes the returned SVG under `securityLevel: "strict"`.
      dangerouslySetInnerHTML={{ __html: visibleState.svg }}
    />
  );
}
