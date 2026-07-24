import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { cloneElement, memo, type ReactElement, useCallback, useState } from "react";
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

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactElement | null;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onSelectionComplete: () => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const completeSelection = useCallback(() => {
    setIsMenuOpen(false);
    props.onSelectionComplete();
  }, [props.onSelectionComplete]);
  const traitsMenuContent = props.traitsMenuContent
    ? cloneElement(props.traitsMenuContent as ReactElement<{ onSelectionComplete?: () => void }>, {
        onSelectionComplete: completeSelection,
      })
    : null;

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
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
        {traitsMenuContent ? (
          <>
            {traitsMenuContent}
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
                completeSelection();
              }}
            >
              <MenuRadioItem closeOnClick value="default">
                Chat
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="plan">
                Plan
              </MenuRadioItem>
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
            completeSelection();
          }}
        >
          <MenuRadioItem closeOnClick value="approval-required">
            Supervised
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="auto-accept-edits">
            Auto-accept edits
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="auto">
            Auto
          </MenuRadioItem>
          <MenuRadioItem closeOnClick value="full-access">
            Full access
          </MenuRadioItem>
        </MenuRadioGroup>
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem
              onClick={() => {
                props.onTogglePlanSidebar();
                completeSelection();
              }}
            >
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
