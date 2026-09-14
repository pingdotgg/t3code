import type { AgentSessionPreviewResult, EnvironmentId } from "@t3tools/contracts";

import { onboardingHistorySessionKey } from "../../onboarding/projectImport.logic";
import { formatRelativeTime } from "../../timestampFormat";
import { Checkbox } from "../ui/checkbox";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface PreviewProject {
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly path: string;
  readonly title: string;
}

export function OnboardingHistoryPreview({
  projects,
  previews,
  environmentLabels,
  selectedKeys,
  onSelectionChange,
}: {
  readonly projects: ReadonlyArray<PreviewProject>;
  readonly previews: ReadonlyMap<string, AgentSessionPreviewResult>;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly selectedKeys: ReadonlySet<string>;
  readonly onSelectionChange: (next: ReadonlySet<string>) => void;
}) {
  const environmentIds = [...new Set(projects.map((project) => project.environmentId))];
  const toggleSession = (
    projectKey: string,
    session: AgentSessionPreviewResult["sessions"][number],
    checked: boolean,
  ) => {
    const next = new Set(selectedKeys);
    const key = onboardingHistorySessionKey(projectKey, session);
    if (checked) next.add(key);
    else next.delete(key);
    onSelectionChange(next);
  };

  return (
    <ScrollArea
      scrollFade
      className="mt-5 h-auto max-h-72 [&_[data-slot=scroll-area-scrollbar]]:opacity-100"
    >
      <div className="space-y-5 pr-3">
        {environmentIds.map((environmentId) => {
          const environmentProjects = projects.filter(
            (project) => project.environmentId === environmentId,
          );
          return (
            <section key={environmentId} className="min-w-0">
              {environmentIds.length > 1 ? (
                <h2 className="mb-2 text-sm font-medium">
                  {environmentLabels.get(environmentId) ?? "Computer"}
                </h2>
              ) : null}
              <div className="space-y-4">
                {environmentProjects.map((project) => {
                  const preview = previews.get(project.key);
                  if (preview === undefined) return null;
                  const omittedCount =
                    preview.alreadyImportedCount +
                    preview.excludedCount +
                    preview.failedCount +
                    preview.deferredCount;
                  return (
                    <section key={project.key} className="min-w-0">
                      <div className="mb-1 flex min-w-0 items-baseline justify-between gap-3 px-2">
                        <Tooltip>
                          <TooltipTrigger render={<h3 className="truncate text-sm font-medium" />}>
                            {project.title}
                          </TooltipTrigger>
                          <TooltipPopup className="max-w-96 break-all font-mono">
                            {project.path}
                          </TooltipPopup>
                        </Tooltip>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {preview.sessions.length}{" "}
                          {preview.sessions.length === 1 ? "conversation" : "conversations"}
                        </span>
                      </div>
                      {preview.sessions.length === 0 ? (
                        <p className="px-2 py-1 text-xs text-muted-foreground">
                          No new recent conversations are available.
                        </p>
                      ) : (
                        <div className="space-y-0.5">
                          {preview.sessions.map((session) => {
                            const key = onboardingHistorySessionKey(project.key, session);
                            const relative = formatRelativeTime(session.createdAt);
                            const age =
                              relative === null
                                ? ""
                                : relative.suffix === null
                                  ? "now"
                                  : relative.value;
                            return (
                              <label
                                key={key}
                                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40"
                              >
                                <Checkbox
                                  checked={selectedKeys.has(key)}
                                  onCheckedChange={(checked) =>
                                    toggleSession(project.key, session, checked === true)
                                  }
                                />
                                <span className="min-w-0 flex-1 truncate text-sm">
                                  {session.title}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                  {session.messageCount} msg · {age}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {omittedCount > 0 ? (
                        <p className="mt-1 px-2 text-xs text-muted-foreground">
                          {preview.alreadyImportedCount > 0
                            ? `${preview.alreadyImportedCount} already in T3 Code. `
                            : ""}
                          {preview.excludedCount > 0 ? `${preview.excludedCount} excluded. ` : ""}
                          {preview.failedCount > 0
                            ? `${preview.failedCount} could not be read. `
                            : ""}
                          {preview.deferredCount > 0
                            ? `${preview.deferredCount} more deferred by the preview limit.`
                            : ""}
                        </p>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </ScrollArea>
  );
}
