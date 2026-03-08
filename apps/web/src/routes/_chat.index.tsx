import { createFileRoute } from "@tanstack/react-router";

import ChatShellHeaderBar from "../components/ChatShellHeaderBar";
import { isElectron } from "../env";

function ChatIndexRouteView() {
  const titleClassName = isElectron
    ? "text-xs font-medium tracking-wide text-muted-foreground/70"
    : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      <ChatShellHeaderBar
        title={isElectron ? "No active thread" : "Threads"}
        {...(titleClassName ? { titleClassName } : {})}
      />

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm">Select a thread or create a new one to get started.</p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
