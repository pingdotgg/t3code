import type { CSSProperties } from "react";
import { useState } from "react";

import { cn } from "../lib/utils";

interface AcpRegistryIconProps {
  agentId: string;
  className?: string;
}

export function AcpRegistryIcon({ agentId, className }: AcpRegistryIconProps) {
  const [loadError, setLoadError] = useState(false);

  const initials = agentId
    .split(/[-_]/)
    .map((part) => part[0]?.toUpperCase())
    .join("")
    .slice(0, 2);

  if (loadError) {
    return (
      <span
        role="img"
        aria-label={agentId}
        className={cn(
          "inline-flex items-center justify-center rounded bg-muted text-foreground font-medium",
          className,
        )}
      >
        {initials}
      </span>
    );
  }

  // CSS masks let bundled monochrome SVGs inherit currentColor.
  const maskUrl = `url("/acp-icons/${agentId}.svg")`;
  const style: CSSProperties = {
    maskImage: maskUrl,
    WebkitMaskImage: maskUrl,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
    maskSize: "contain",
    WebkitMaskSize: "contain",
  };

  return (
    <>
      <img
        src={`/acp-icons/${agentId}.svg`}
        alt=""
        onError={() => setLoadError(true)}
        style={{ display: "none" }}
      />
      <span
        role="img"
        aria-label={agentId}
        aria-hidden
        className={cn("inline-block bg-current text-foreground", className)}
        style={style}
      />
    </>
  );
}
