import { Suspense, useState } from "react";

import { cachedHighlight, highlightKey } from "./highlight";
import { HighlightedCode, plainCode } from "./HighlightedCode";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

/** The colored code of a fence. A finished block comes from the cache, and one that streamed keeps its lines. */
export function CodeBody({
  code,
  language,
  streaming,
}: {
  code: string;
  language: string;
  streaming: boolean;
}) {
  const [hasStreamed, setHasStreamed] = useState(streaming);
  if (streaming && !hasStreamed) setHasStreamed(true);
  const cacheKey = highlightKey(language, code);
  const cached = !streaming && !hasStreamed ? cachedHighlight(cacheKey) : undefined;
  if (cached !== undefined) {
    return <div className="board-code" dangerouslySetInnerHTML={{ __html: cached }} />;
  }
  return (
    <RenderErrorBoundary resetKeys={[code, language, streaming]} fallback={plainCode(code)}>
      <Suspense
        fallback={
          <div className="invisible" aria-hidden>
            {plainCode(code)}
          </div>
        }
      >
        <HighlightedCode
          code={code}
          language={language}
          streaming={streaming}
          cacheKey={cacheKey}
          preserveLines={streaming || hasStreamed}
        />
      </Suspense>
    </RenderErrorBoundary>
  );
}
