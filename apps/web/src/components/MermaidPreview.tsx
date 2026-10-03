import { canPreviewMermaid, renderMermaidPreview } from "@t3tools/client-runtime/mermaid-preview";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/button";

export function MermaidPreview({
  source,
  theme,
  enabled,
  children,
}: {
  source: string;
  theme: "light" | "dark";
  enabled: boolean;
  children: ReactNode;
}) {
  const [requestedSource, setRequestedSource] = useState<string | null>(null);
  const open = requestedSource === source;
  const [result, setResult] = useState<{ key: string; uri: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${theme}:${source}`;
  useEffect(() => {
    if (!open || !enabled) return;
    const controller = new AbortController();
    void renderMermaidPreview(source, theme, controller.signal).then(
      ({ svg }) => {
        if (!controller.signal.aborted)
          setResult({ key, uri: `data:image/svg+xml,${encodeURIComponent(svg)}` });
      },
      () => {
        if (!controller.signal.aborted) setError(key);
      },
    );
    return () => controller.abort();
  }, [enabled, key, open, source, theme]);
  return (
    <>
      {enabled && canPreviewMermaid(source) ? (
        <div className="px-3 pt-2">
          <Button
            size="xs"
            variant="ghost-muted"
            aria-pressed={open}
            onClick={() => {
              setResult(null);
              setError(null);
              setRequestedSource(open ? null : source);
            }}
          >
            {open ? "Hide diagram" : "Preview diagram"}
          </Button>
        </div>
      ) : null}
      {open && enabled ? (
        <div className="max-h-96 overflow-auto px-3 pt-2" aria-live="polite">
          {result?.key === key ? (
            <img src={result.uri} alt="Mermaid diagram" className="max-w-none" />
          ) : (
            <p className="text-xs text-muted-foreground">
              {error === key
                ? "Could not preview this diagram. Source is shown below."
                : "Preparing diagram..."}
            </p>
          )}
        </div>
      ) : null}
      {children}
    </>
  );
}
