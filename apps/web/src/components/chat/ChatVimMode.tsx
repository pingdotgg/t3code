import { useGT } from "gt-react";
import { useState } from "react";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { requestWorkspaceFocus } from "~/lib/workspaceFocus";
import { InlineButton } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import {
  attachChatVimNavigation,
  type ChatVimModeName,
  type ChatVimNavigationProps,
} from "./chatVimNavigation";

export function ChatVimMode({
  readOnly,
  listRef,
  navigateTimeline,
  composerRef,
  enterVimNormalModeRef,
}: ChatVimNavigationProps) {
  const gt = useGT();
  const [mode, setMode] = useState<ChatVimModeName>("INSERT");
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const focusSidebar = useStableCallback(() => {
    if (!document.querySelector("[data-app-sidebar]")) return;
    if (isMobile) setOpenMobile(true);
    else setOpen(true);
    requestWorkspaceFocus({ area: "sidebar", restore: false });
  });
  const leaveSidebar = useStableCallback((focusChat: () => void) => {
    if (isMobile) {
      setOpenMobile(false);
      requestAnimationFrame(focusChat);
    } else focusChat();
  });
  const copy = useStableCallback(async (text: string) => {
    try {
      const copied = await writeTextToClipboard(text);
      if (copied) toastManager.add({ type: "success", title: gt("Copied") });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Failed to copy"),
        description: error instanceof Error ? error.message : undefined,
      });
    }
  });
  const attachButton = (button: HTMLButtonElement | null) => {
    const column = button?.closest<HTMLElement>("[data-chat-column]");
    if (!button || !column) return;
    return attachChatVimNavigation(
      button,
      column,
      {
        readOnly,
        listRef,
        navigateTimeline,
        composerRef,
        enterVimNormalModeRef,
        focusSidebar,
        leaveSidebar,
      },
      setMode,
      copy,
    );
  };

  const hint = {
    INSERT: readOnly ? null : gt("Esc to navigate"),
    NORMAL: readOnly
      ? gt("h/j/k/l move · J/K messages · gd sidebar · v select · Esc exit")
      : gt("h/j/k/l move · J/K messages · gd sidebar · v select · i type"),
    VISUAL: gt("iw word · ip paragraph · y copy · Esc cancel"),
  }[mode];
  return (
    <div className="mt-1 flex w-fit max-w-full items-center gap-2 rounded-md bg-background px-2 py-0.5 text-xs text-muted-foreground">
      <InlineButton
        ref={attachButton}
        emphasis="weight"
        aria-label={
          mode === "INSERT" || mode === "VISUAL"
            ? gt("Enter Vim normal mode")
            : readOnly
              ? gt("Exit Vim navigation")
              : gt("Return to typing")
        }
      >
        <span
          data-mode={mode}
          lang={readOnly && mode === "INSERT" ? undefined : "en"}
          className="font-mono data-[mode=NORMAL]:text-success-foreground data-[mode=VISUAL]:text-vim-visual-foreground"
          aria-live="polite"
        >
          {readOnly && mode === "INSERT" ? gt("Enter Vim normal mode") : mode}
        </span>
      </InlineButton>
      {hint && <span className="min-w-0">{hint}</span>}
    </div>
  );
}
