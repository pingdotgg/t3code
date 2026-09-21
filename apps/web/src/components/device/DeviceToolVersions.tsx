import type { DeviceToolVersions as ToolVersions } from "@t3tools/contracts";
import { deviceToolVersionLabels } from "@t3tools/client-runtime/state/device";

export function DeviceToolVersions({ tools }: { tools: ToolVersions | undefined }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {deviceToolVersionLabels(tools).map((label) => (
        <p key={label}>{label}</p>
      ))}
    </div>
  );
}
