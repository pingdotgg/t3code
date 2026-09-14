import type { ReactNode } from "react";

import { isElectron } from "../env";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { SidebarInset } from "./ui/sidebar";

export function AgentDashboardPageShell({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="flex h-dvh min-h-0 min-w-0 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/70" />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <header className="flex flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </header>
          {children}
        </div>
      </main>
    </SidebarInset>
  );
}
