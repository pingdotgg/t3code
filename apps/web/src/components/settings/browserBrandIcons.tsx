import type { ImgHTMLAttributes } from "react";

import { cn } from "../../lib/utils";
import agentCursorUrl from "../../assets/computer-use/agent-cursor-icon.png";
import braveUrl from "../../assets/computer-use/brave.svg";
import chromeUrl from "../../assets/computer-use/google-chrome.svg";
import edgeUrl from "../../assets/computer-use/edge.svg";
import firefoxUrl from "../../assets/computer-use/firefox.svg";

type BrandIconProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  alt?: string;
};

function BrandImg({ src, alt = "", className, ...props }: BrandIconProps & { src: string }) {
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      className={cn("object-contain", className)}
      {...props}
    />
  );
}

export function ChromeIcon({ alt = "", ...props }: BrandIconProps) {
  return <BrandImg src={chromeUrl} alt={alt} {...props} />;
}

export function EdgeIcon({ alt = "", ...props }: BrandIconProps) {
  return <BrandImg src={edgeUrl} alt={alt} {...props} />;
}

export function BraveIcon({ alt = "", ...props }: BrandIconProps) {
  return <BrandImg src={braveUrl} alt={alt} {...props} />;
}

export function FirefoxIcon({ alt = "", ...props }: BrandIconProps) {
  return <BrandImg src={firefoxUrl} alt={alt} {...props} />;
}

/** Same soft-glow pointer used by the desktop agent-cursor overlay. */
export function AgentCursorIcon({ alt = "", className, ...props }: BrandIconProps) {
  return <BrandImg src={agentCursorUrl} alt={alt} className={className} {...props} />;
}
