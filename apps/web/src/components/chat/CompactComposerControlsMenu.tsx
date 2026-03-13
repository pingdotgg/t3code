import {
  type CodexReasoningEffort,
  type ProviderKind,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { memo } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { CODEX_REASONING_EFFORT_LABELS } from "../../codexReasoningEffort";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  defaultEffort: CodexReasoningEffort;
  interactionMode: ProviderInteractionMode;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  selectedEffort: CodexReasoningEffort | null;
  selectedProvider: ProviderKind;
  selectedCodexFastModeEnabled: boolean;
  reasoningOptions: ReadonlyArray<CodexReasoningEffort>;
  onEffortSelect: (effort: CodexReasoningEffort) => void;
  onCodexFastModeChange: (enabled: boolean) => void;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onToggleRuntimeMode: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.selectedProvider === "codex" && props.selectedEffort != null ? (
          <>
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Reasoning</div>
              <MenuRadioGroup
                value={props.selectedEffort}
                onValueChange={(value) => {
                  if (!value) return;
                  const nextEffort = props.reasoningOptions.find((option) => option === value);
                  if (!nextEffort) return;
                  props.onEffortSelect(nextEffort);
                }}
              >
                {props.reasoningOptions.map((effort) => (
                  <MenuRadioItem key={effort} value={effort}>
                    {CODEX_REASONING_EFFORT_LABELS[effort]}
                    {effort === props.defaultEffort ? " (default)" : ""}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuDivider />
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Fast Mode</div>
              <MenuRadioGroup
                value={props.selectedCodexFastModeEnabled ? "on" : "off"}
                onValueChange={(value) => {
                  props.onCodexFastModeChange(value === "on");
                }}
              >
                <MenuRadioItem value="off">off</MenuRadioItem>
                <MenuRadioItem value="on">on</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
            <MenuDivider />
          </>
        ) : null}
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
          <MenuRadioGroup
            value={props.interactionMode}
            onValueChange={(value) => {
              if (!value || value === props.interactionMode) return;
              props.onToggleInteractionMode();
            }}
          >
            <MenuRadioItem value="default">Chat</MenuRadioItem>
            <MenuRadioItem value="plan">Plan</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!value || value === props.runtimeMode) return;
              props.onToggleRuntimeMode();
            }}
          >
            <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
            <MenuRadioItem value="full-access">Full access</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
