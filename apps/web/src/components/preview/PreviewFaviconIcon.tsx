import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useFaviconForThreadUrl } from "~/browserFaviconStore";
import { cn } from "~/lib/utils";

import { BrowserMockup } from "./BrowserMockup";

type Props = { threadRef: ScopedThreadRef; url: string; className?: string | undefined };

export function PreviewFaviconIcon({ threadRef, url, className }: Props) {
  const src = useFaviconForThreadUrl(threadRef, url);
  if (!src) return <BrowserMockup className={cn("size-7 shrink-0", className)} />;
  return <PreviewFaviconImage key={src} src={src} className={className} />;
}

function PreviewFaviconImage({ src, className }: Pick<Props, "className"> & { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <BrowserMockup className={cn("size-7 shrink-0", className)} />;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn("size-7 shrink-0 rounded object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}
