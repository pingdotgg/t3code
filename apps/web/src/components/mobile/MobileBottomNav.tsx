import { LayoutListIcon, MessageSquareIcon, TerminalSquareIcon } from "lucide-react";

import { cn } from "~/lib/utils";

type NavButtonProps = {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
};

function NavButton({ icon, label, active = false, onClick }: NavButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-1 items-center justify-center min-h-12"
      aria-label={label}
      aria-pressed={active}
    >
      <span
        className={cn(
          "flex flex-col items-center justify-center gap-0.5 rounded-full px-4 py-1.5 transition-colors duration-150",
          active
            ? "bg-accent/60 text-foreground"
            : "text-foreground/55 group-hover:text-foreground/85 group-active:bg-accent/30",
        )}
      >
        <span className="size-[22px]" aria-hidden="true">
          {icon}
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wider">{label}</span>
      </span>
    </button>
  );
}

type MobileBottomNavProps = {
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  terminalOpen: boolean;
};

export function MobileBottomNav({
  onToggleSidebar,
  onToggleTerminal,
  terminalOpen,
}: MobileBottomNavProps) {
  return (
    <>
      {/* Soft gradient lift sits above the nav instead of a hard border. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-50 h-2 md:hidden bg-gradient-to-t from-background/80 to-transparent"
      />
      <nav
        className="fixed bottom-0 inset-x-0 z-50 md:hidden flex h-14 bg-background/80 backdrop-blur-xl backdrop-saturate-150 pb-[env(safe-area-inset-bottom)]"
        aria-label="Main navigation"
      >
        <NavButton
          icon={<LayoutListIcon className="size-[22px]" />}
          label="Sessions"
          onClick={onToggleSidebar}
        />
        <NavButton
          icon={<MessageSquareIcon className="size-[22px]" />}
          label="Chat"
          onClick={() => {
            const composer = document.querySelector<HTMLElement>(
              "[data-chat-composer-form='true']",
            );
            composer?.scrollIntoView({ behavior: "smooth", block: "end" });
            const textarea = composer?.querySelector<HTMLElement>(
              "textarea, [contenteditable='true']",
            );
            if (textarea) {
              window.requestAnimationFrame(() => textarea.focus());
            }
          }}
        />
        <NavButton
          icon={<TerminalSquareIcon className="size-[22px]" />}
          label="Terminal"
          active={terminalOpen}
          onClick={onToggleTerminal}
        />
      </nav>
    </>
  );
}
