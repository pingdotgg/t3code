import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode, useRef } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControlShortcutHint } from "./ComposerControlShortcutHint";

export function compactComposerShortcutHintLabel(input: {
  modelOptions: string | null;
  modelOptionsAvailable: boolean;
  runtimeMode: string | null;
  runtimeModeAvailable: boolean;
  planMode: string | null;
  planModeAvailable: boolean;
}): string | null {
  const labels = [
    input.modelOptionsAvailable && input.modelOptions ? `Options ${input.modelOptions}` : null,
    input.runtimeModeAvailable && input.runtimeMode ? `Access ${input.runtimeMode}` : null,
    input.planModeAvailable && input.planMode ? `Plan ${input.planMode}` : null,
  ].filter((label): label is string => label !== null);
  return labels.length > 0 ? labels.join(" · ") : null;
}

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  shortcutHintLabel: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Menu
        {...(props.open !== undefined ? { open: props.open } : {})}
        {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}
      >
        <MenuTrigger
          render={
            <Button
              ref={triggerRef}
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
          {props.traitsMenuContent ? (
            <>
              {props.traitsMenuContent}
              <MenuDivider />
            </>
          ) : null}
          {props.showInteractionModeToggle ? (
            <>
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
              <MenuDivider />
            </>
          ) : null}
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!value || value === props.runtimeMode) return;
              props.onRuntimeModeChange(value as RuntimeMode);
            }}
          >
            <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
            <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
            <MenuRadioItem value="auto">Auto</MenuRadioItem>
            <MenuRadioItem value="full-access">Full access</MenuRadioItem>
          </MenuRadioGroup>
          {props.activePlan ? (
            <>
              <MenuDivider />
              <MenuItem onClick={props.onTogglePlanSidebar}>
                <ListTodoIcon className="size-4 shrink-0" />
                {props.planSidebarOpen
                  ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                  : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      <ComposerControlShortcutHint anchorRef={triggerRef} label={props.shortcutHintLabel} />
    </>
  );
});
