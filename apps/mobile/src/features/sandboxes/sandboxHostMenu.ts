import type { SandboxTone } from "@t3tools/client-runtime/sandboxes/presentation";
import type { EnvironmentId } from "@t3tools/contracts";

import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../components/EnvironmentMachineSymbol";
import type { StatusTone } from "../../components/StatusPill";
import type { AppBarMenu } from "../../components/ui/AppBar.types";
import type { SandboxHostOption } from "./useSandboxes";

export const SANDBOX_TONE_CLASSES = {
  success: {
    pillClassName: "bg-adaptive-emerald-500-a12-a16",
    textClassName: "text-adaptive-emerald-700-300",
  },
  info: { pillClassName: "bg-update", textClassName: "text-update-foreground" },
  warning: { pillClassName: "bg-warning", textClassName: "text-warning-foreground" },
  error: { pillClassName: "bg-danger", textClassName: "text-danger-foreground" },
  muted: { pillClassName: "bg-subtle", textClassName: "text-foreground-secondary" },
} as const satisfies Record<SandboxTone, Omit<StatusTone, "label">>;

/**
 * The machine whose Sandboxes a screen shows, picked as Settings picks the machine it applies
 * to. With one host there is nothing to pick, so there is no menu.
 */
export function sandboxHostMenu(
  options: ReadonlyArray<SandboxHostOption>,
  value: EnvironmentId | null,
  onChange: (hostEnvironmentId: EnvironmentId) => void,
): AppBarMenu | null {
  if (options.length < 2) return null;
  const selected = options.find((option) => option.hostEnvironmentId === value);
  return {
    title: `Sandbox host: ${selected?.label ?? "Unavailable host"}`,
    icon: selected ? ENVIRONMENT_MACHINE_SYMBOLS[selected.machine] : "desktopcomputer",
    items: options.map((option) => ({
      id: option.hostEnvironmentId,
      title: option.label,
      icon: ENVIRONMENT_MACHINE_SYMBOLS[option.machine],
      subtitle: option.offline ? `${option.summary} · Offline` : option.summary,
      selected: option.hostEnvironmentId === value,
      onPress: () => onChange(option.hostEnvironmentId),
    })),
  };
}
