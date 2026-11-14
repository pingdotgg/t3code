import type { ProviderDriverKind } from "@t3tools/contracts";
import { ZapIcon } from "lucide-react";
import { UltrafastIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

export function TraitsSpeedIcon({
  provider,
  speedIcon,
  size = "sm",
}: {
  provider: ProviderDriverKind;
  speedIcon: "fast" | "ultrafast";
  size?: ComposerControlSize;
}) {
  return (
    <>
      <ComposerControlIcon
        icon={speedIcon === "ultrafast" ? UltrafastIcon : ZapIcon}
        size={size}
        className={cn(
          "fill-current opacity-80",
          size === "xs"
            ? "text-current"
            : provider === "claudeAgent"
              ? "text-[#d97757]"
              : "text-foreground",
        )}
      />
      <span className="sr-only">
        {speedIcon === "ultrafast" ? "Ultrafast mode on" : "Fast mode on"}
      </span>
    </>
  );
}
