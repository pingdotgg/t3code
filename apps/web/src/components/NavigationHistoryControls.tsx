import { useAtomValue } from "@effect/atom-react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect } from "react";

import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn } from "../lib/utils";
import { useNavigationHistory } from "../navigationHistory";
import { primaryServerKeybindingsAtom } from "../state/server";
import { Button } from "./ui/button";
import { WORKSPACE_TITLEBAR_CONTROL_CLASS } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
interface NavigationHistoryButtonsProps {
  readonly backShortcut: string | null;
  readonly buttonClassName?: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly forwardShortcut: string | null;
  readonly onBack: () => void;
  readonly onForward: () => void;
}
function NavigationButton(props: {
  readonly available: boolean;
  readonly className?: string;
  readonly icon: "back" | "forward";
  readonly label: string;
  readonly onPress: () => void;
  readonly shortcut: string | null;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-disabled={!props.available}
            aria-label={props.label}
            className={cn(
              WORKSPACE_TITLEBAR_CONTROL_CLASS,
              "aria-disabled:cursor-not-allowed aria-disabled:opacity-64 aria-disabled:hover:bg-transparent",
              props.className,
            )}
            onClick={() => {
              if (props.available) props.onPress();
            }}
            size="icon"
            variant="ghost"
          >
            {props.icon === "back" ? <ArrowLeftIcon /> : <ArrowRightIcon />}
          </Button>
        }
      />
      <TooltipPopup side="bottom">
        {props.shortcut ? `${props.label} (${props.shortcut})` : props.label}
      </TooltipPopup>
    </Tooltip>
  );
}
export function NavigationHistoryButtons(props: NavigationHistoryButtonsProps) {
  return (
    <div aria-label="Navigation history" className="flex items-center gap-0.5" role="group">
      <NavigationButton
        available={props.canGoBack}
        {...(props.buttonClassName ? { className: props.buttonClassName } : {})}
        icon="back"
        label="Back"
        onPress={props.onBack}
        shortcut={props.backShortcut}
      />
      <NavigationButton
        available={props.canGoForward}
        {...(props.buttonClassName ? { className: props.buttonClassName } : {})}
        icon="forward"
        label="Forward"
        onPress={props.onForward}
        shortcut={props.forwardShortcut}
      />
    </div>
  );
}
function useNavigationHistoryShortcuts(input: {
  readonly back: () => void;
  readonly forward: () => void;
  readonly keybindings: ResolvedKeybindingsConfig;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      const command = resolveShortcutCommand(event, input.keybindings, {
        context: {
          previewFocus: isPreviewFocused(),
          terminalFocus: isTerminalFocused(),
        },
      });
      if (command !== "navigation.back" && command !== "navigation.forward") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      (command === "navigation.back" ? input.back : input.forward)();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [input.back, input.forward, input.keybindings]);
}
export function NavigationHistoryControls({
  buttonClassName,
}: {
  readonly buttonClassName?: string;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { back, canGoBack, canGoForward, forward } = useNavigationHistory();
  const backShortcut = shortcutLabelForCommand(keybindings, "navigation.back");
  const forwardShortcut = shortcutLabelForCommand(keybindings, "navigation.forward");
  useNavigationHistoryShortcuts({ back, forward, keybindings });
  return (
    <NavigationHistoryButtons
      backShortcut={backShortcut}
      {...(buttonClassName ? { buttonClassName } : {})}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      forwardShortcut={forwardShortcut}
      onBack={back}
      onForward={forward}
    />
  );
}
