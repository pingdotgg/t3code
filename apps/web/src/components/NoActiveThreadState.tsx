import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { DatabaseConsole } from "./neuropharm/DatabaseConsole";
import { NeuropharmWorkspacePanel } from "./neuropharm/NeuropharmWorkspacePanel";
import { ResearchConsole } from "./neuropharm/ResearchConsole";

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron ? "workspace-topbar drag-region" : "workspace-topbar",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[var(--workspace-native-controls-inset)]">
              Neuropharm Research
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                Neuropharm Research
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-6xl px-6 py-8">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-2xl">
                Neuropharm research workspace
              </EmptyTitle>
              <EmptyDescription className="mt-3 text-sm text-muted-foreground/78">
                Analyze pharmacological compounds, receptor interactions, and cognitive effects
                using curated databases from PubChem, ChEMBL, IUPHAR, and PubMed. Generate
                evidence-based reports with standardized figures and confidence ratings.
              </EmptyDescription>
            </EmptyHeader>
            <div className="mt-6">
              <NeuropharmWorkspacePanel />
            </div>
            <div className="mt-6">
              <ResearchConsole />
            </div>
            <div className="mt-6">
              <DatabaseConsole />
            </div>
            <div className="mt-6">
              <div className="rounded-md border border-border/60 bg-background/60 p-3 text-xs text-muted-foreground">
                Research mode: All pharmacological claims are labeled with evidence strength.
                Unsupported extrapolations and low-confidence predictions are clearly marked. This
                tool generates research summaries, not medical advice.
              </div>
            </div>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
