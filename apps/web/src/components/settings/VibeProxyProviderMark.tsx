import { AntigravityIcon, ClaudeAI, Gemini, GrokIcon, OpenAI, type Icon } from "../Icons";
import { cn } from "~/lib/utils";
import {
  vibeProxyProviderInitials,
  vibeProxyProviderKind,
  type VibeProxyProviderKind,
} from "@t3tools/shared/vibeProxyUsage";

/** Brand marks already shipped in `components/Icons`. */
const PROVIDER_MARK: Readonly<Partial<Record<VibeProxyProviderKind, Icon>>> = {
  codex: OpenAI,
  claude: ClaudeAI,
  antigravity: AntigravityIcon,
  gemini: Gemini,
  grok: GrokIcon,
};

/**
 * Brand mark for a Vibe-Proxy provider string, falling back to initials so an
 * unrecognised provider still reads as a distinct group rather than a blank.
 */
export function VibeProxyProviderMark({
  provider,
  className,
}: {
  readonly provider: string;
  readonly className?: string;
}) {
  const Mark = PROVIDER_MARK[vibeProxyProviderKind(provider)];

  if (!Mark) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-muted text-[8px] font-semibold leading-none text-muted-foreground",
          className,
        )}
      >
        {vibeProxyProviderInitials(provider)}
      </span>
    );
  }

  return <Mark aria-hidden className={cn("size-4 shrink-0", className)} />;
}
