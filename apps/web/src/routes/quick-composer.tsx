import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { Kbd } from "../components/ui/kbd";
import { Textarea } from "../components/ui/textarea";
import { useProjects, useThreadShells } from "../state/entities";

const PROMPT_ID = "quick-composer-prompt";

// Desktop only: the main process opens this route in its floating Quick Composer window.
export const Route = createFileRoute("/quick-composer")({
  component: QuickComposerRoute,
});

function QuickComposerRoute() {
  const bridge = window.desktopBridge?.quickComposer;
  const projects = useProjects();
  const threads = useThreadShells();
  const choices = sortScopedProjectsForSidebar(
    projects.filter((project) => project.isScratch !== true && !project.archivedAt),
    threads,
    "updated_at",
  );
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const keyOf = (project: (typeof choices)[number]) =>
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  const project = choices.find((choice) => keyOf(choice) === projectKey) ?? choices[0];
  const [prompt, setPrompt] = useState("");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the window is reused: focus the prompt on every show and hide it on Escape
  useEffect(() => {
    const focusPrompt = () => document.getElementById(PROMPT_ID)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void bridge?.hide();
    };
    focusPrompt();
    window.addEventListener("focus", focusPrompt);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("focus", focusPrompt);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [bridge]);

  const submit = () => {
    const text = prompt.trim();
    if (bridge === undefined || project === undefined || text.length === 0) return;
    setPrompt("");
    void bridge.submit({
      environmentId: project.environmentId,
      projectId: project.id,
      prompt: text,
    });
  };

  return (
    <main className="flex h-dvh flex-col gap-2 overflow-hidden rounded-2xl border border-border bg-background p-3 text-foreground">
      <Textarea
        id={PROMPT_ID}
        rows={3}
        autoFocus
        placeholder={project ? `Start a thread in ${project.title}…` : "Loading projects…"}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        {/* Native select: its list may extend past this small window. */}
        <select
          aria-label="Project"
          className="min-w-0 max-w-80 truncate rounded-md border border-input bg-background px-2 py-1 text-foreground"
          value={project ? keyOf(project) : ""}
          disabled={choices.length === 0}
          onChange={(event) => setProjectKey(event.target.value)}
        >
          {choices.map((choice) => (
            <option key={keyOf(choice)} value={keyOf(choice)}>
              {choice.title}
            </option>
          ))}
        </select>
        <span className="flex shrink-0 items-center gap-1">
          <Kbd>Enter</Kbd> send <Kbd>Esc</Kbd> close
        </span>
      </div>
    </main>
  );
}
