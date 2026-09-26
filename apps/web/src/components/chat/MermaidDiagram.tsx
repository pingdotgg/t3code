import { useEffect, useState, type ReactNode } from "react";

import { getCachedMermaidSvg, renderMermaidSvg, type MermaidTheme } from "~/lib/mermaid";

/**
 * Draws `code` as a mermaid diagram, the way GitHub does. Shows `children`, the highlighted
 * source, when `code` is null, while the diagram renders, or when mermaid cannot parse it.
 */
export function MermaidDiagram({
  code,
  theme,
  children,
}: {
  code: string | null;
  theme: MermaidTheme;
  children: ReactNode;
}) {
  const key = `${theme}\n${code}`;
  const [resolved, setResolved] = useState<{ key: string; svg: string | null } | null>(null);
  // A cache hit draws on the first frame, so remounting a scrolled body does not flash.
  const cached = code === null ? null : getCachedMermaidSvg(code, theme);
  const svg = cached ?? (resolved?.key === key ? resolved.svg : null);

  useEffect(() => {
    if (code === null || cached != null) return;
    let cancelled = false;
    void renderMermaidSvg(code, theme).then(
      (rendered) => !cancelled && setResolved({ key, svg: rendered }),
      () => !cancelled && setResolved({ key, svg: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [cached, code, key, theme]);

  if (svg === null) return children;
  return (
    <div
      className="chat-markdown-mermaid flex justify-center overflow-x-auto px-3 pt-1 pb-3"
      // Mermaid runs its own DOMPurify pass at the `strict` security level set in lib/mermaid.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
