import { Logo } from "@posthog/brand/logo";

import { APP_DISPLAY_NAME } from "../branding";
import { cn } from "../lib/utils";

/**
 * The hedgehog logomark, drawn in the ambient text color. Use this wherever a
 * surface needs the brand rather than the app's name.
 */
export function AppLogomark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <Logo
      variant="mono"
      layout="logomark"
      size={size}
      title="PostHog"
      className={cn("shrink-0", className)}
    />
  );
}

/** The logomark beside the app's name, for page and card headers. */
export function AppLockup({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <AppLogomark size={18} />
      <span className="text-[11px] font-semibold tracking-[0.18em] uppercase">
        {APP_DISPLAY_NAME}
      </span>
    </div>
  );
}
