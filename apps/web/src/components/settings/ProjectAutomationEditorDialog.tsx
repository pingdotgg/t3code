import {
  BUILTIN_JOBS,
  resolveJob,
  type AutomationAction,
  type AutomationGitHubIssueEvent,
  type AutomationGitHubPrEvent,
  type AutomationTrigger,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type T3ProjectFileAutomation,
  type T3ProjectFileJob,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { BotIcon, ClockIcon, GitPullRequestIcon, CircleDotIcon, TerminalIcon } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import type { ModelEsque } from "~/components/chat/providerIconUtils";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import type { ProviderInstanceEntry } from "~/providerInstances";

const PR_EVENTS: Array<{ id: AutomationGitHubPrEvent; label: string }> = [
  { id: "opened", label: "Opened" },
  { id: "synchronize", label: "Synchronize (Pushed)" },
  { id: "closed", label: "Closed" },
  { id: "merged", label: "Merged" },
  { id: "reopened", label: "Reopened" },
  { id: "review_requested", label: "Review Requested" },
];

const ISSUE_EVENTS: Array<{ id: AutomationGitHubIssueEvent; label: string }> = [
  { id: "opened", label: "Opened" },
  { id: "closed", label: "Closed" },
  { id: "reopened", label: "Reopened" },
  { id: "labeled", label: "Labeled" },
  { id: "assigned", label: "Assigned" },
];

const CRON_PRESETS = [
  { label: "Hourly", value: "@hourly" },
  { label: "Daily (Midnight)", value: "@daily" },
  { label: "Weekdays 9 AM", value: "0 9 * * 1-5" },
  { label: "Every 15 mins", value: "*/15 * * * *" },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ProjectAutomationEditorDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly automation: T3ProjectFileAutomation | null;
  readonly existingIds: ReadonlyArray<string>;
  readonly onSave: (automation: T3ProjectFileAutomation) => void;
  readonly instanceEntries?: ReadonlyArray<ProviderInstanceEntry> | undefined;
  readonly modelOptionsByInstance?:
    | ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>
    | undefined;
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly onOpenProviderSetup?: ((instanceId: ProviderInstanceId) => void) | undefined;
  readonly projectJobs?: ReadonlyArray<T3ProjectFileJob> | undefined;
}

export function ProjectAutomationEditorDialog({
  open,
  onOpenChange,
  automation,
  existingIds,
  onSave,
  instanceEntries,
  modelOptionsByInstance,
  defaultModelSelection,
  onOpenProviderSetup,
  projectJobs,
}: ProjectAutomationEditorDialogProps) {
  const isEditing = automation !== null;

  const [name, setName] = useState(() => (automation ? automation.name : ""));
  const [id, setId] = useState(() => (automation ? automation.id : ""));
  const [idManuallyEdited, setIdManuallyEdited] = useState(() => Boolean(automation));
  const [enabled, setEnabled] = useState(() => (automation ? (automation.enabled ?? true) : true));

  const [triggerType, setTriggerType] = useState<"cron" | "github_pr" | "github_issue">(() =>
    automation ? automation.trigger.type : "cron",
  );
  const [cronSchedule, setCronSchedule] = useState(() =>
    automation?.trigger.type === "cron" ? automation.trigger.schedule : "0 9 * * 1-5",
  );
  const [prEvents, setPrEvents] = useState<AutomationGitHubPrEvent[]>(() =>
    automation?.trigger.type === "github_pr" && automation.trigger.events
      ? [...automation.trigger.events]
      : ["opened", "synchronize"],
  );
  const [prBranches, setPrBranches] = useState(() =>
    automation?.trigger.type === "github_pr"
      ? (automation.trigger.targetBranches?.join(", ") ?? "")
      : "",
  );
  const [issueEvents, setIssueEvents] = useState<AutomationGitHubIssueEvent[]>(() =>
    automation?.trigger.type === "github_issue" && automation.trigger.events
      ? [...automation.trigger.events]
      : ["opened"],
  );
  const [issueLabels, setIssueLabels] = useState(() =>
    automation?.trigger.type === "github_issue"
      ? (automation.trigger.labels?.join(", ") ?? "")
      : "",
  );

  const [actionType, setActionType] = useState<"thread" | "script">(() =>
    automation ? automation.action.type : "thread",
  );
  const [jobId, setJobId] = useState<string>(() =>
    automation?.action.type === "thread" ? (automation.action.jobId ?? "") : "",
  );
  const [threadTitle, setThreadTitle] = useState(() =>
    automation?.action.type === "thread" ? (automation.action.title ?? "") : "",
  );
  const [threadPrompt, setThreadPrompt] = useState(() =>
    automation?.action.type === "thread"
      ? automation.action.prompt
      : "Analyze recent repository activity and generate a status update.",
  );
  const [selectedModelSelection, setSelectedModelSelection] = useState<ModelSelection | null>(() =>
    automation?.action.type === "thread" ? (automation.action.modelSelection ?? null) : null,
  );
  const [scriptCommand, setScriptCommand] = useState(() =>
    automation?.action.type === "script" ? (automation.action.command ?? "") : "npm test",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const effectiveSelection = useMemo(() => {
    if (selectedModelSelection) {
      return selectedModelSelection;
    }
    if (defaultModelSelection) {
      return defaultModelSelection;
    }
    const firstEntry = instanceEntries?.[0];
    if (firstEntry && firstEntry.models.length > 0) {
      return {
        instanceId: firstEntry.instanceId,
        model: firstEntry.models[0]?.slug ?? "",
      };
    }
    return null;
  }, [selectedModelSelection, defaultModelSelection, instanceEntries]);

  const activeEntry = useMemo(() => {
    if (!instanceEntries || instanceEntries.length === 0) return null;
    if (effectiveSelection) {
      const match = instanceEntries.find(
        (entry) => entry.instanceId === effectiveSelection.instanceId,
      );
      if (match) return match;
    }
    return instanceEntries[0] ?? null;
  }, [effectiveSelection, instanceEntries]);

  const activeSelection = useMemo(() => {
    if (!activeEntry) return null;
    if (effectiveSelection && effectiveSelection.instanceId === activeEntry.instanceId) {
      return effectiveSelection;
    }
    const defaultModel = activeEntry.models[0]?.slug ?? "";
    return {
      instanceId: activeEntry.instanceId,
      model: defaultModel,
    };
  }, [activeEntry, effectiveSelection]);

  const resolvedModelOptionsByInstance = useMemo(
    () => modelOptionsByInstance ?? new Map(),
    [modelOptionsByInstance],
  );

  const hasProviders = Boolean(instanceEntries && instanceEntries.length > 0);

  useEffect(() => {
    if (!open) return;

    if (automation) {
      setName(automation.name);
      setId(automation.id);
      setIdManuallyEdited(true);
      setEnabled(automation.enabled ?? true);

      if (automation.trigger.type === "cron") {
        setTriggerType("cron");
        setCronSchedule(automation.trigger.schedule);
      } else if (automation.trigger.type === "github_pr") {
        setTriggerType("github_pr");
        setPrEvents(
          automation.trigger.events ? [...automation.trigger.events] : ["opened", "synchronize"],
        );
        setPrBranches(automation.trigger.targetBranches?.join(", ") ?? "");
      } else if (automation.trigger.type === "github_issue") {
        setTriggerType("github_issue");
        setIssueEvents(automation.trigger.events ? [...automation.trigger.events] : ["opened"]);
        setIssueLabels(automation.trigger.labels?.join(", ") ?? "");
      }

      if (automation.action.type === "thread") {
        setActionType("thread");
        setJobId(automation.action.jobId ?? "");
        setThreadTitle(automation.action.title ?? "");
        setThreadPrompt(automation.action.prompt);
        setSelectedModelSelection(automation.action.modelSelection ?? null);
      } else {
        setActionType("script");
        setScriptCommand(automation.action.command ?? "");
        setSelectedModelSelection(null);
      }
    } else {
      setName("");
      setId("");
      setIdManuallyEdited(false);
      setEnabled(true);
      setTriggerType("cron");
      setCronSchedule("0 9 * * 1-5");
      setPrEvents(["opened", "synchronize"]);
      setPrBranches("");
      setIssueEvents(["opened"]);
      setIssueLabels("");
      setActionType("thread");
      setJobId("");
      setThreadTitle("");
      setThreadPrompt("Analyze recent repository activity and generate a status update.");
      setSelectedModelSelection(null);
      setScriptCommand("npm test");
    }
    setErrorMessage(null);
  }, [open, automation]);

  const handleNameChange = (val: string) => {
    setName(val);
    if (!idManuallyEdited && !isEditing) {
      setId(slugify(val));
    }
  };

  const activeJob = useMemo(() => {
    return resolveJob(jobId, projectJobs);
  }, [jobId, projectJobs]);

  const handleJobChange = (newJobId: string) => {
    setJobId(newJobId);
    const resolved = resolveJob(newJobId, projectJobs);
    if (resolved?.promptTemplate) {
      setThreadPrompt(resolved.promptTemplate);
    }
  };
  const handleInsertVariable = (variable: string) => {
    setThreadPrompt((prev) => `${prev} \${${variable}}`);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedName = name.trim();
    const trimmedId = id.trim() || slugify(trimmedName);

    if (!trimmedName) {
      setErrorMessage("Please enter an automation name.");
      return;
    }
    if (!trimmedId) {
      setErrorMessage("Please enter a valid unique ID.");
      return;
    }
    if ((!isEditing || trimmedId !== automation.id) && existingIds.includes(trimmedId)) {
      setErrorMessage(`An automation with ID "${trimmedId}" already exists.`);
      return;
    }

    let trigger: AutomationTrigger;
    if (triggerType === "cron") {
      const schedule = cronSchedule.trim();
      if (!schedule) {
        setErrorMessage("Please specify a cron schedule.");
        return;
      }
      trigger = { type: "cron", schedule };
    } else if (triggerType === "github_pr") {
      if (prEvents.length === 0) {
        setErrorMessage("Please select at least one PR event.");
        return;
      }
      const branches = prBranches
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);
      trigger = {
        type: "github_pr",
        events: prEvents,
        ...(branches.length > 0 ? { targetBranches: branches } : {}),
      };
    } else {
      if (issueEvents.length === 0) {
        setErrorMessage("Please select at least one Issue event.");
        return;
      }
      const labels = issueLabels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
      trigger = {
        type: "github_issue",
        events: issueEvents,
        ...(labels.length > 0 ? { labels } : {}),
      };
    }

    let action: AutomationAction;
    if (actionType === "thread") {
      const prompt = (threadPrompt ?? "").trim();
      if (!prompt) {
        setErrorMessage("Please enter a prompt template for the thread.");
        return;
      }
      const title = threadTitle.trim();
      action = {
        type: "thread",
        prompt,
        ...(jobId ? { jobId } : {}),
        ...(title ? { title } : {}),
        ...(selectedModelSelection ? { modelSelection: selectedModelSelection } : {}),
      };
    } else {
      const command = scriptCommand.trim();
      if (!command) {
        setErrorMessage("Please enter a shell command to execute.");
        return;
      }
      action = {
        type: "script",
        command,
      };
    }

    const payload: T3ProjectFileAutomation = {
      id: trimmedId,
      name: trimmedName,
      enabled,
      trigger,
      action,
    };

    onSave(payload);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Automation" : "Add Automation"}</DialogTitle>
          <DialogDescription>
            Automations are stored in <code className="font-mono text-xs">t3.json</code> at your
            project root.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <form id="automation-editor-form" onSubmit={handleSubmit} className="space-y-4">
            {errorMessage && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2.5 text-xs text-destructive">
                {errorMessage}
              </div>
            )}

            {/* General Info */}
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="automation-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="automation-name"
                  placeholder="e.g. Daily CI, PR Reviewer"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  className="text-xs"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="automation-id" className="text-xs">
                  ID (slug)
                </Label>
                <Input
                  id="automation-id"
                  placeholder="e.g. daily-ci, pr-reviewer"
                  value={id}
                  onChange={(e) => {
                    setId(e.target.value);
                    setIdManuallyEdited(true);
                  }}
                  className="font-mono text-xs"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="automation-enabled" className="text-xs">
                    Enable Automation
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Inactive automations remain in t3.json but will not trigger.
                  </p>
                </div>
                <Switch id="automation-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>

            {/* Trigger Selection */}
            <div className="space-y-2 pt-1">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Trigger
              </Label>
              <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-border/60 bg-muted/40 p-1">
                <button
                  type="button"
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    triggerType === "cron"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setTriggerType("cron")}
                >
                  <ClockIcon className="size-3.5" />
                  Cron Schedule
                </button>
                <button
                  type="button"
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    triggerType === "github_pr"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setTriggerType("github_pr")}
                >
                  <GitPullRequestIcon className="size-3.5" />
                  GitHub PR
                </button>
                <button
                  type="button"
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    triggerType === "github_issue"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setTriggerType("github_issue")}
                >
                  <CircleDotIcon className="size-3.5" />
                  GitHub Issue
                </button>
              </div>

              {triggerType === "cron" && (
                <div className="space-y-2 rounded-lg border border-border/60 p-3">
                  <div className="space-y-1">
                    <Label htmlFor="cron-schedule" className="text-xs">
                      Schedule Expression (Cron)
                    </Label>
                    <Input
                      id="cron-schedule"
                      placeholder="0 9 * * 1-5"
                      value={cronSchedule}
                      onChange={(e) => setCronSchedule(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {CRON_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        className="rounded border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => setCronSchedule(preset.value)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {triggerType === "github_pr" && (
                <div className="space-y-3 rounded-lg border border-border/60 p-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">PR Events</Label>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {PR_EVENTS.map((event) => {
                        const isChecked = prEvents.includes(event.id);
                        return (
                          <label
                            key={event.id}
                            className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <Checkbox
                              checked={isChecked}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setPrEvents((prev) => [...prev, event.id]);
                                } else {
                                  setPrEvents((prev) => prev.filter((e) => e !== event.id));
                                }
                              }}
                            />
                            <span>{event.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="pr-branches" className="text-xs">
                      Target Branches Filter (optional)
                    </Label>
                    <Input
                      id="pr-branches"
                      placeholder="main, production (comma separated)"
                      value={prBranches}
                      onChange={(e) => setPrBranches(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                </div>
              )}

              {triggerType === "github_issue" && (
                <div className="space-y-3 rounded-lg border border-border/60 p-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Issue Events</Label>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {ISSUE_EVENTS.map((event) => {
                        const isChecked = issueEvents.includes(event.id);
                        return (
                          <label
                            key={event.id}
                            className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <Checkbox
                              checked={isChecked}
                              onCheckedChange={(checked) => {
                                if (checked) {
                                  setIssueEvents((prev) => [...prev, event.id]);
                                } else {
                                  setIssueEvents((prev) => prev.filter((e) => e !== event.id));
                                }
                              }}
                            />
                            <span>{event.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="issue-labels" className="text-xs">
                      Labels Filter (optional)
                    </Label>
                    <Input
                      id="issue-labels"
                      placeholder="bug, agent-ready (comma separated)"
                      value={issueLabels}
                      onChange={(e) => setIssueLabels(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Action Selection */}
            <div className="space-y-2 pt-1">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Action
              </Label>
              <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border/60 bg-muted/40 p-1">
                <button
                  type="button"
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    actionType === "thread"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setActionType("thread")}
                >
                  <BotIcon className="size-3.5" />
                  Agent Thread
                </button>
                <button
                  type="button"
                  className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                    actionType === "script"
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setActionType("script")}
                >
                  <TerminalIcon className="size-3.5" />
                  Run Script / Command
                </button>
              </div>

              {actionType === "thread" && (
                <div className="space-y-3 rounded-lg border border-border/60 p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="thread-job" className="text-xs">
                      Agent Job / Role (optional)
                    </Label>
                    <select
                      id="thread-job"
                      value={jobId}
                      onChange={(e) => handleJobChange(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground shadow-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
                    >
                      <option value="">Generic Agent (No specialized job)</option>
                      <optgroup label="Built-in Jobs">
                        {BUILTIN_JOBS.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.name}
                          </option>
                        ))}
                      </optgroup>
                      {projectJobs && projectJobs.length > 0 ? (
                        <optgroup label="Project Jobs">
                          {projectJobs.map((j) => (
                            <option key={j.id} value={j.id}>
                              {j.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </select>
                    {activeJob ? (
                      <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs text-muted-foreground">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-foreground">{activeJob.name}</span>
                          {activeJob.promptTemplate ? (
                            <button
                              type="button"
                              className="text-[11px] text-primary hover:underline"
                              onClick={() => setThreadPrompt(activeJob.promptTemplate ?? "")}
                            >
                              Reset to job prompt
                            </button>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed">{activeJob.description}</p>
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="thread-title" className="text-xs">
                      Thread Title Template (optional)
                    </Label>
                    <Input
                      id="thread-title"
                      placeholder="e.g. Review PR #${pr.number}: ${pr.title}"
                      value={threadTitle}
                      onChange={(e) => setThreadTitle(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="thread-prompt" className="text-xs">
                      Prompt Template
                    </Label>
                    <Textarea
                      id="thread-prompt"
                      rows={3}
                      placeholder="Please review the changes in pull request #${pr.number}."
                      value={threadPrompt}
                      onChange={(e) => setThreadPrompt(e.target.value)}
                      className="text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Model & Provider</Label>
                      {selectedModelSelection ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedModelSelection(null)}
                        >
                          Reset to project default
                        </Button>
                      ) : null}
                    </div>
                    {hasProviders && activeSelection && activeEntry && instanceEntries ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ProviderModelPicker
                          activeInstanceId={activeSelection.instanceId}
                          model={activeSelection.model}
                          lockedProvider={null}
                          instanceEntries={instanceEntries}
                          modelOptionsByInstance={resolvedModelOptionsByInstance}
                          triggerVariant="outline"
                          triggerClassName="h-8 text-xs font-normal"
                          {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
                          onInstanceModelChange={(instanceId, model) => {
                            setSelectedModelSelection(createModelSelection(instanceId, model));
                          }}
                        />
                        <TraitsPicker
                          planModeEnabled={false}
                          provider={activeEntry.driverKind as ProviderDriverKind}
                          instanceId={activeEntry.instanceId}
                          models={activeEntry.models}
                          model={activeSelection.model}
                          prompt=""
                          onPromptChange={() => {}}
                          modelOptions={
                            "options" in activeSelection ? activeSelection.options : undefined
                          }
                          onModelOptionsChange={(options) =>
                            setSelectedModelSelection(
                              createModelSelection(
                                activeSelection.instanceId,
                                activeSelection.model,
                                options,
                              ),
                            )
                          }
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {instanceEntries && instanceEntries.length === 0
                          ? "No providers available."
                          : "Project default model will be used."}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {selectedModelSelection
                        ? "Custom model configured for this automation."
                        : "Inherits the project default model unless customized."}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <span className="text-[11px] text-muted-foreground">Available Variables:</span>
                    <div className="flex flex-wrap gap-1">
                      {[
                        "pr.number",
                        "pr.title",
                        "pr.headRefName",
                        "pr.baseRefName",
                        "issue.number",
                        "issue.title",
                        "event.type",
                        "project.title",
                      ].map((v) => (
                        <button
                          key={v}
                          type="button"
                          className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => handleInsertVariable(v)}
                        >
                          ${`{${v}}`}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {actionType === "script" && (
                <div className="space-y-2 rounded-lg border border-border/60 p-3">
                  <Label htmlFor="script-command" className="text-xs">
                    Shell Command
                  </Label>
                  <Input
                    id="script-command"
                    placeholder="npm test"
                    value={scriptCommand}
                    onChange={(e) => setScriptCommand(e.target.value)}
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Executed at the project root directory when the trigger fires.
                  </p>
                </div>
              )}
            </div>
          </form>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button form="automation-editor-form" type="submit">
            {isEditing ? "Save Changes" : "Create Automation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
