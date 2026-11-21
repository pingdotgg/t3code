import { ArrowLeft, Download, GitBranch, Plug, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { SidebarRow } from "../sidebar/SidebarRow";

export type SettingsPage = "worktrees" | "cleanup" | "integrations" | "updates";

const PAGES = [
  { id: "worktrees", title: "Worktrees", icon: <GitBranch className="size-3.5" /> },
  { id: "cleanup", title: "Cleanup", icon: <Trash2 className="size-3.5" /> },
  { id: "integrations", title: "Integrations", icon: <Plug className="size-3.5" /> },
  { id: "updates", title: "Updates", icon: <Download className="size-3.5" /> },
] as const satisfies ReadonlyArray<{ id: SettingsPage; title: string; icon: ReactNode }>;

export const pageTitle = (page: SettingsPage) =>
  PAGES.find((entry) => entry.id === page)?.title ?? "";

export function SettingsNav({
  page,
  onPage,
  onBack,
}: {
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  onBack: () => void;
}) {
  return (
    <nav
      aria-label="Settings"
      className="flex min-h-0 flex-col gap-1 border-r border-line bg-sidebar px-2.5 py-3"
    >
      <SidebarRow icon={<ArrowLeft className="size-3.5" />} title="Back to app" onClick={onBack} />
      <p className="px-2 pt-3 pb-1 text-[13px] font-medium text-muted">Settings</p>
      {PAGES.map((entry) => (
        <SidebarRow
          key={entry.id}
          icon={entry.icon}
          title={entry.title}
          selected={page === entry.id}
          onClick={() => onPage(entry.id)}
        />
      ))}
    </nav>
  );
}
