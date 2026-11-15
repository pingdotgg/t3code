import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { AgentEyesNarration } from "@t3tools/contracts/settings";
import { EyeIcon } from "lucide-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

const NARRATION_LABELS: Record<AgentEyesNarration, string> = {
  off: "Watch only",
  brief: "Brief narration",
  detailed: "Detailed narration",
};

/**
 * Agent Eyes in the model picker: opens the live view for this thread, and chooses whether agents
 * narrate their steps. Watching is free; narration is extra model output, so it says so.
 */
export function AgentEyesPickerControl({
  environmentId,
  threadRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const open = useRightPanelStore(
    (state) =>
      threadRef !== null && selectActiveRightPanel(state.byThreadKey, threadRef) === "agent-eyes",
  );
  const narration = useEnvironmentSettings(
    environmentId,
    (settings) => settings.agentEyesNarration,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  return (
    <div className="flex items-center gap-1" data-agent-eyes-picker>
      <button
        type="button"
        aria-pressed={open}
        disabled={threadRef === null}
        className={cn(
          "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:opacity-50",
          open ? "bg-foreground/[0.09] text-foreground" : "text-muted-foreground",
        )}
        onClick={() => {
          if (threadRef !== null) useRightPanelStore.getState().toggle(threadRef, "agent-eyes");
        }}
      >
        <EyeIcon aria-hidden="true" className="size-3.5" />
        Agent Eyes
      </button>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Agent Eyes narration: ${NARRATION_LABELS[narration]}`}
              className="flex h-7 cursor-pointer items-center rounded-md px-1.5 text-muted-foreground text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-foreground/[0.09]"
            />
          }
        >
          {NARRATION_LABELS[narration]}
        </MenuTrigger>
        <MenuPopup side="top" align="start" className="w-72">
          <MenuGroup>
            <MenuGroupLabel>Narration</MenuGroupLabel>
            <MenuRadioGroup
              value={narration}
              onValueChange={(value) =>
                void updateSettings({ agentEyesNarration: value as AgentEyesNarration })
              }
            >
              {(Object.keys(NARRATION_LABELS) as AgentEyesNarration[]).map((level) => (
                <MenuRadioItem key={level} value={level} closeOnClick>
                  {NARRATION_LABELS[level]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <p className="px-2 pb-2 text-muted-foreground text-xs" data-agent-eyes-usage-warning>
            Watching uses no extra model usage. Narration asks agents to describe each step before
            they take it, which adds output to every turn and uses more of your plan or credits.
          </p>
        </MenuPopup>
      </Menu>
    </div>
  );
}
