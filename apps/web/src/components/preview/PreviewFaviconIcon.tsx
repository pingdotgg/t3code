import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { useFaviconForThreadUrl } from "~/browserFaviconStore";
import { cn } from "~/lib/utils";

import { BrowserMockup } from "./BrowserMockup";

export function selectFaviconSource(
  sources: ReadonlyArray<string>,
  failed: ReadonlySet<string>,
): string | null {
  return sources.find((candidate) => !failed.has(candidate)) ?? null;
}

export function FaviconImage(props: {
  sources: ReadonlyArray<string | null | undefined>;
  fallback: ReactNode;
  className?: string | undefined;
}) {
  const sources = props.sources.filter((source): source is string => Boolean(source));
  return (
    <FaviconImageAttempt
      key={sources.join("\0")}
      sources={sources}
      fallback={props.fallback}
      className={props.className}
    />
  );
}

function FaviconImageAttempt(props: {
  sources: ReadonlyArray<string>;
  fallback: ReactNode;
  className?: string | undefined;
}) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const source = selectFaviconSource(props.sources, failed);
  if (!source) return props.fallback;
  return (
    <img
      src={source}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={props.className}
      onError={() => setFailed((current) => new Set(current).add(source))}
    />
  );
}

export function PreviewFaviconIcon(props: {
  threadRef: ScopedThreadRef;
  url: string;
  className?: string | undefined;
}) {
  const source = useFaviconForThreadUrl(props.threadRef, props.url);
  const fallback = <BrowserMockup className={cn("size-7 shrink-0", props.className)} />;
  return (
    <FaviconImage
      sources={[source]}
      fallback={fallback}
      className={cn("size-7 shrink-0 rounded object-contain", props.className)}
    />
  );
}
