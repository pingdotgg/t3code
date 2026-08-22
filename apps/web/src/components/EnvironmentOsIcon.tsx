import type { ExecutionEnvironmentPlatformOs } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import type { Icon } from "./Icons";
import { AppleIcon, LinuxIcon, WindowsIcon } from "./OsIcons";

/** Every OS the server can report, except "unknown", which has no glyph. */
const OS_PRESENTATION = {
  darwin: { label: "macOS", Icon: AppleIcon },
  linux: { label: "Linux", Icon: LinuxIcon },
  windows: { label: "Windows", Icon: WindowsIcon },
} as const satisfies Record<
  Exclude<ExecutionEnvironmentPlatformOs, "unknown">,
  { readonly label: string; readonly Icon: Icon }
>;

/**
 * The platform glyph beside a remote environment's name. `os` is null when no
 * descriptor is available (an environment that has never connected and is
 * currently unreachable), in which case nothing renders — an absent glyph
 * reads better than a placeholder for an unknown platform.
 */
export function EnvironmentOsIcon({
  os,
  className,
}: {
  readonly os: ExecutionEnvironmentPlatformOs | null;
  readonly className?: string;
}) {
  if (os === null || os === "unknown") {
    return null;
  }
  const { label, Icon } = OS_PRESENTATION[os];

  return (
    <Icon
      role="img"
      aria-label={label}
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
    />
  );
}
