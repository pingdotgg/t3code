import { useNavigate } from "@tanstack/react-router";
import { BoxIcon, PlusIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { openNewSandboxDialog } from "./NewSandboxDialog";
import { useOffersSandboxes } from "./useSandboxes";

/** "Open Sandboxes", where each Sandbox is managed, and "New Sandbox…". */
export function useSandboxPaletteItems(): CommandPaletteActionItem[] {
  const navigate = useNavigate();
  if (!useOffersSandboxes()) return [];
  return [
    {
      kind: "action",
      value: "action:open-agentctl-sandboxes",
      title: "Open Sandboxes",
      searchTerms: ["sandboxes", "agentctl", "start", "stop", "delete", "manifest folders", "vm"],
      icon: <BoxIcon className={ITEM_ICON_CLASS} />,
      run: async () => void navigate({ to: "/sandboxes" }),
    },
    {
      kind: "action",
      value: "action:new-agentctl-sandbox",
      title: "New Sandbox…",
      searchTerms: ["new sandbox", "create sandbox", "agentctl", "apply", "manifest", "vm"],
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => openNewSandboxDialog(),
    },
  ];
}
