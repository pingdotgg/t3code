import type { RuntimeMode } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

export const runtimeModeTranslationKeys = {
  "approval-required": {
    label: "runtimeSupervised",
    description: "runtimeSupervisedDescription",
  },
  "auto-accept-edits": {
    label: "runtimeAutoAcceptEdits",
    description: "runtimeAutoAcceptEditsDescription",
  },
  auto: { label: "runtimeAuto", description: "runtimeAutoDescription" },
  "full-access": {
    label: "runtimeFullAccess",
    description: "runtimeFullAccessDescription",
  },
} as const satisfies Record<RuntimeMode, { label: string; description: string }>;
