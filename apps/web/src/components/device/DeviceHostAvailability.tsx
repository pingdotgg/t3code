import type { DevicePlatformAvailability } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { Check, Minus } from "lucide-react";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function DeviceHostAvailability({
  platforms,
}: {
  platforms: ReadonlyArray<DevicePlatformAvailability>;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {platforms.map((platform) => (
        <SharedTooltipTrigger
          key={platform.platform}
          render={<span tabIndex={0} className="inline-flex items-center gap-1" />}
          label={
            platform.reason ??
            gt("{platform} available", {
              platform: platform.platform === "ios" ? "iOS" : "Android",
            })
          }
        >
          {platform.available ? <Check className="size-3" /> : <Minus className="size-3" />}
          {platform.available
            ? gt("{platform} available", {
                platform: platform.platform === "ios" ? "iOS" : "Android",
              })
            : gt("{platform} unavailable", {
                platform: platform.platform === "ios" ? "iOS" : "Android",
              })}
        </SharedTooltipTrigger>
      ))}
    </div>
  );
}
