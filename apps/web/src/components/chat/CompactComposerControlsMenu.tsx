import { ProviderInteractionMode, RuntimeMode } from "@harness/contracts";
import { memo, type ReactNode } from "react";
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
  runtimeModeLocked: boolean;
  runtimeModeLockReason?: string | undefined;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const interactionModeDescription =
    props.interactionMode === "ask"
      ? "Read/explain only. No writes."
      : props.interactionMode === "plan"
        ? "Research and propose a plan without implementing."
        : "Explore and implement changes.";

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
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <div className="px-2 pb-1 text-muted-foreground/70 text-xs">
              {interactionModeDescription}
            </div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onInteractionModeChange(value as ProviderInteractionMode);
              }}
            >
              <MenuRadioItem value="default">Build</MenuRadioItem>
              <MenuRadioItem value="ask">Ask</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        {props.runtimeModeLocked ? (
          <div className="px-2 pb-1 text-muted-foreground/70 text-xs">
            {props.runtimeModeLockReason ?? "ASK mode locks access to Supervised."}
          </div>
        ) : null}
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits" disabled={props.runtimeModeLocked}>
            Auto-accept edits
          </MenuRadioItem>
          <MenuRadioItem value="full-access" disabled={props.runtimeModeLocked}>
            Full access
          </MenuRadioItem>
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
  );
});
