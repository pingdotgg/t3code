import { useAtomValue } from "@effect/atom-react";
import { Mic2Icon } from "lucide-react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useVoicePanelStore } from "../../voice/voicePanelStore";
import { Kbd } from "../ui/kbd";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export function VoicePanelSidebarMenuItem({ onSelect }: { readonly onSelect?: () => void }) {
  const open = useVoicePanelStore((state) => state.open);
  const toggleVoicePanel = useVoicePanelStore((state) => state.toggleVoicePanel);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "voice.toggle");
  const tooltip = `${open ? "Hide" : "Open"} voice supervisor${shortcutLabel ? ` (${shortcutLabel})` : ""}`;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        isActive={open}
        tooltip={tooltip}
        aria-label={tooltip}
        aria-expanded={open}
        aria-pressed={open}
        aria-controls="voice-supervisor-panel"
        onClick={() => {
          toggleVoicePanel();
          onSelect?.();
        }}
      >
        <Mic2Icon />
        <span>Voice</span>
        {shortcutLabel ? (
          <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">{shortcutLabel}</Kbd>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
