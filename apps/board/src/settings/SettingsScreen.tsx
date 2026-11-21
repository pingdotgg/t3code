import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { engineEnvironmentIdAtom, environmentProjects } from "../state/projects";
import { engineSettingsAtom } from "../state/server";
import { CleanupPage } from "./CleanupPage";
import { Select } from "./controls/Select";
import { IntegrationsPage } from "./IntegrationsPage";
import { ReviewsPage } from "./ReviewsPage";
import { pageTitle, SettingsNav, type SettingsPage } from "./SettingsNav";
import { UpdatesPage } from "./UpdatesPage";
import { type SaveStatus, useSettingsWrite } from "./useSettingsWrite";
import { WorktreesPage } from "./WorktreesPage";

const ENVIRONMENT = "";

function statusText(status: SaveStatus): string {
  switch (status.kind) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "failed":
      return status.message;
    case "idle":
      return "";
  }
}

// Two frames: the first commits the page, the second runs after it has been painted. Each marker
// is a stable function, so a re-render does not run it again.
const paintedMarker = (name: string) => (node: HTMLElement | null) => {
  if (node === null) return;
  const frame = requestAnimationFrame(() => requestAnimationFrame(() => performance.mark(name)));
  return () => cancelAnimationFrame(frame);
};

const markPainted = paintedMarker("board:settings-painted");
const PAGE_PAINTED = {
  worktrees: paintedMarker("board:worktrees-painted"),
  cleanup: paintedMarker("board:cleanup-painted"),
  integrations: paintedMarker("board:integrations-painted"),
  updates: paintedMarker("board:updates-painted"),
  reviews: paintedMarker("board:reviews-painted"),
} satisfies Record<SettingsPage, ReturnType<typeof paintedMarker>>;

export function SettingsScreen({
  page,
  onPage,
  onBack,
}: {
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  onBack: () => void;
}) {
  const settings = useAtomValue(engineSettingsAtom);
  const environmentId = useAtomValue(engineEnvironmentIdAtom);
  const allProjects = useAtomValue(environmentProjects.projectsAtom);
  const [scope, setScope] = useState(ENVIRONMENT);
  const { status, save } = useSettingsWrite();
  const projects = allProjects.filter((entry) => entry.archivedAt == null);
  const project = projects.find((entry) => entry.id === scope) ?? null;
  const scopes: ReadonlyArray<{ value: string; title: string }> = [
    { value: ENVIRONMENT, title: "All projects" },
    ...projects.map((entry) => ({ value: entry.id, title: entry.title })),
  ];

  return (
    <div ref={markPainted} className="grid min-h-0 grid-cols-[240px_minmax(0,1fr)]">
      <SettingsNav
        page={page}
        onPage={(next) => {
          performance.mark(`board:${next}-open`);
          onPage(next);
        }}
        onBack={onBack}
      />
      <main
        ref={PAGE_PAINTED[page]}
        className="min-h-0 min-w-0 overflow-y-auto scrollbar-gutter-both"
      >
        <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-8 py-6">
          <header className="flex items-center justify-between gap-4">
            <h1 className="text-lg font-semibold tracking-tight">{pageTitle(page)}</h1>
            <div className="flex items-center gap-3">
              <span
                role="status"
                className={status.kind === "failed" ? "text-red-400" : "text-faint"}
              >
                {statusText(status)}
              </span>
              {(page === "worktrees" || page === "cleanup") && (
                <Select
                  label="Settings for"
                  value={project?.id ?? ENVIRONMENT}
                  options={scopes}
                  onChange={setScope}
                />
              )}
            </div>
          </header>
          {settings === null || environmentId === null ? (
            <p className="text-faint">Waiting for the engine's settings.</p>
          ) : page === "worktrees" ? (
            <WorktreesPage
              settings={settings}
              project={project}
              save={(input) => void save(input)}
            />
          ) : page === "integrations" ? (
            <IntegrationsPage environmentId={environmentId} />
          ) : page === "updates" ? (
            <UpdatesPage settings={settings} save={(input) => void save(input)} />
          ) : page === "reviews" ? (
            <ReviewsPage environmentId={environmentId} />
          ) : (
            <CleanupPage
              settings={settings}
              environmentId={environmentId}
              project={project}
              projects={projects}
              save={(input) => void save(input)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
