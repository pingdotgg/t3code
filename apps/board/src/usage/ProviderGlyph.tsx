import { Bot } from "lucide-react";

export function ProviderGlyph({ driver }: { driver: string }) {
  if (driver === "claudeAgent") {
    return (
      <span aria-hidden className="text-[13px] leading-none text-[#d97757]">
        ✳
      </span>
    );
  }
  return <Bot aria-hidden className="size-3.5 text-muted" />;
}
