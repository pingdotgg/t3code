import type { ModelSelection, ServerConfig } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { GitCompareArrowsIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { launchBakeoff, type Bakeoff } from "../bakeoffs";
import { deriveProviderInstanceEntries } from "../providerInstances";
import type { Project } from "../types";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

interface ContestantOption {
  key: string;
  label: string;
  modelSelection: ModelSelection;
}

function projectKey(project: Pick<Project, "environmentId" | "id">): string {
  return `${project.environmentId}:${project.id}`;
}

function contestantOptions(config: ServerConfig | null): ContestantOption[] {
  if (!config) return [];
  return deriveProviderInstanceEntries(config.providers).flatMap((entry) => {
    if (!entry.enabled || !entry.isAvailable || entry.status !== "ready") return [];
    return entry.models.map((model) => ({
      key: `${entry.instanceId}\0${model.slug}`,
      label: `${entry.displayName} · ${model.name}`,
      modelSelection: createModelSelection(entry.instanceId, model.slug),
    }));
  });
}

export function BakeoffCreateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ReadonlyArray<Project>;
  configByEnvironmentId: ReadonlyMap<string, ServerConfig | null>;
  onCreated: (bakeoff: Bakeoff) => void;
}) {
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selectedContestantKeys, setSelectedContestantKeys] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [launching, setLaunching] = useState(false);
  const selectedProject =
    props.projects.find((project) => projectKey(project) === selectedProjectKey) ?? null;
  const options = useMemo(
    () =>
      contestantOptions(
        selectedProject
          ? (props.configByEnvironmentId.get(selectedProject.environmentId) ?? null)
          : null,
      ),
    [props.configByEnvironmentId, selectedProject],
  );

  useEffect(() => {
    if (!props.open) return;
    setSelectedProjectKey(
      (current) => current || (props.projects[0] ? projectKey(props.projects[0]) : ""),
    );
  }, [props.open, props.projects]);

  useEffect(() => {
    setSelectedContestantKeys(new Set(options.slice(0, 2).map((option) => option.key)));
  }, [options]);

  const selectedContestants = options.filter((option) => selectedContestantKeys.has(option.key));
  const canLaunch =
    selectedProject !== null && prompt.trim().length > 0 && selectedContestants.length >= 2;

  const handleLaunch = async () => {
    if (!selectedProject || !canLaunch) return;
    setLaunching(true);
    try {
      const bakeoff = await launchBakeoff({
        project: selectedProject,
        title,
        prompt: prompt.trim(),
        contestants: selectedContestants,
      });
      props.onCreated(bakeoff);
      props.onOpenChange(false);
      setTitle("");
      setPrompt("");
      const failedCount = bakeoff.contestants.filter((contestant) => contestant.launchError).length;
      toastManager.add({
        type: failedCount > 0 ? "warning" : "success",
        title: failedCount > 0 ? "Bakeoff launched with failures" : "Bakeoff launched",
        description:
          failedCount > 0
            ? `${bakeoff.contestants.length - failedCount} of ${bakeoff.contestants.length} contestants started.`
            : `${bakeoff.contestants.length} contestants are running in isolated worktrees.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Bakeoff launch failed",
        description: error instanceof Error ? error.message : "The bakeoff could not be launched.",
      });
    } finally {
      setLaunching(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompareArrowsIcon className="size-5" />
            New multi-agent bakeoff
          </DialogTitle>
          <DialogDescription>
            Run one task with multiple models in separate worktrees, then compare their results.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-5">
          <label className="grid gap-1.5 text-sm font-medium">
            Project
            <select
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/24"
              value={selectedProjectKey}
              onChange={(event) => setSelectedProjectKey(event.target.value)}
            >
              {props.projects.map((project) => (
                <option key={projectKey(project)} value={projectKey(project)}>
                  {project.name} · {project.cwd}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Name
            <Input
              nativeInput
              placeholder="Optional experiment name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Task
            <Textarea
              placeholder="Describe the implementation task every contestant should complete."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <section className="grid gap-2">
            <div>
              <div className="text-sm font-medium">Contestants</div>
              <div className="text-xs text-muted-foreground">
                Select at least two ready models. Each receives the exact same task and base branch.
              </div>
            </div>
            <div className="grid max-h-64 gap-1 overflow-y-auto rounded-xl border border-border p-2">
              {options.length === 0 ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  No ready provider models are available in this environment.
                </div>
              ) : (
                options.map((option) => {
                  const checked = selectedContestantKeys.has(option.key);
                  return (
                    <label
                      key={option.key}
                      className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(nextChecked) =>
                          setSelectedContestantKeys((current) => {
                            const next = new Set(current);
                            if (nextChecked) next.add(option.key);
                            else next.delete(option.key);
                            return next;
                          })
                        }
                      />
                      <span className="truncate">{option.label}</span>
                    </label>
                  );
                })
              )}
            </div>
          </section>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canLaunch || launching} onClick={() => void handleLaunch()}>
            <GitCompareArrowsIcon />
            {launching ? "Launching…" : `Launch ${selectedContestants.length} contestants`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
