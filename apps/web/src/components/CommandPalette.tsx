import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

import {
  dispatchCommandPalette,
  useCommandPaletteMount,
  useCommandPaletteStore,
} from "../commandPaletteStore";
import { ComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import type { CommandPaletteReturnContext } from "./CommandPalette.logic";
import { CommandDialog } from "./ui/command";
import { loadCommandPaletteDialog } from "../commandPaletteModule";

const CommandPaletteDialog = lazy(loadCommandPaletteDialog);

export function CommandPalette({ children }: { children: ReactNode }) {
  useCommandPaletteMount();
  const state = useCommandPaletteStore();
  const [mounted, setMounted] = useState(state.open);
  // Keep the lazy dialog mounted after closing so its exit animation can finish.
  if (state.open && !mounted) setMounted(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Warm the dialog on shortcut intent; search subscriptions stay inside its closed portal.
  useEffect(() => {
    if (mounted) return;
    const warm = (event: KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") {
        void loadCommandPaletteDialog().catch(() => {});
      }
    };
    window.addEventListener("keydown", warm, true);
    return () => {
      window.removeEventListener("keydown", warm, true);
    };
  }, [mounted]);
  const setOpen = (open: boolean) => dispatchCommandPalette({ _tag: "SetOpen", open });
  const openChildSearch = (mode: "files" | "content", context: CommandPaletteReturnContext) =>
    dispatchCommandPalette({ _tag: "OpenChildSearch", mode, context });
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            dispatchCommandPalette({ _tag: "BackToCommand" });
            return;
          }
          setOpen(open);
        }}
      >
        <div className="contents" inert={state.open}>
          {children}
        </div>
        {mounted ? (
          <Suspense fallback={null}>
            <CommandPaletteDialog
              mode={state.mode}
              session={state.session}
              openIntent={state.openIntent}
              setOpen={setOpen}
              openChildSearch={openChildSearch}
              initialContext={state.restoredSearch}
            />
          </Suspense>
        ) : null}
      </CommandDialog>
    </ComposerHandleContext>
  );
}
